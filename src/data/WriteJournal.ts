import type { Vault } from "obsidian";
import { PathLock } from "./PathLock";

/**
 * rotation 閾値: メイン journal がこのサイズを超えたら append 時に rotation を発火。
 * codex final review 反映: readLast の真の OOM 対策として journal 自体のサイズを抑える。
 * 1 MB ≒ 約 5000-10000 entries 程度（1 entry あたり 100-200 byte）。
 */
const ROTATION_THRESHOLD_BYTES = 1024 * 1024;

/**
 * rotation 後にメイン journal に残す行数。
 * 直近 N 件は readLast で素早く参照可能、それ以前は archive ファイル送り。
 */
const ROTATION_KEEP_LINES = 2000;

export type JournalOp =
  | "updateStatus"
  | "updateOrder"
  | "updateFrontmatter"
  /** Phase 3: DetailPane からの frontmatter + 本文同時更新 */
  | "updateTask"
  /** Phase 3: アーカイブフォルダへの rename (内容変更なし) */
  | "archive"
  /** Phase 7: アーカイブから tasks/ への復元 (内容変更なし) */
  | "restore"
  /** Phase 7: 新規タスク作成 */
  | "createTask"
  /** v0.3.0: タスクを OS ゴミ箱経由で削除 */
  | "deleteTask";

export interface JournalEntry {
  ts: string;
  op: JournalOp;
  path: string;
  beforeHash: string;
  afterHash: string;
  /** "undo" は Undo Last による revert 操作の区別。Phase 4 rollback で除外可能に */
  actor: "user" | "migration" | "ai" | "undo";
  approved: boolean;
  /**
   * before/after の値 (snapshot)。rollback で参照する。
   * createTask 等 op によっては JSON 上 key absent になる場合がある
   * (JSON.stringify は undefined を skip するため)。
   */
  beforeData?: Record<string, unknown>;
  afterData?: Record<string, unknown>;
  /** rollback 用にまとめる場合の session id */
  sessionId?: string;
}

/**
 * `秘書/tasks/.kanban-journal.jsonl` への append-only ジャーナル。
 * Phase 4 の migration rollback、Phase 2 の Undo Last の両方で参照する。
 *
 * 形式: 1 行 1 JSON。EOF まで追記、削除なし（古い entry の archive は手動）。
 *
 * 並行 append 対策（Sonnet review Critical 反映）:
 * - 内部で PathLock(relPath) を取得して read-modify-write を直列化
 * - 異なる Task ファイルへの同時 write でも journal entry は消失しない
 * - WriteJournal 自身が PathLock を持つので TaskWriter 側 lock との dead-lock は無い
 *   （TaskWriter は filePath ロック中、journal は JOURNAL_PATH ロック、別軸）
 */
export interface WriteJournalOptions {
  /** rotation を発火するメイン journal のサイズ閾値 (bytes)。既定 1 MB。テスト用に小さく指定可能 */
  rotationThresholdBytes?: number;
  /** rotation 後にメイン journal に残す末尾行数。既定 2000 */
  rotationKeepLines?: number;
}

export class WriteJournal {
  private readonly rotationThreshold: number;
  private readonly rotationKeepLines: number;
  /** archive ファイル名衝突回避用カウンタ。秒粒度 timestamp と組み合わせて使う */
  private archiveCounter = 0;

  constructor(
    private readonly vault: Vault,
    private readonly relPath: string,
    private readonly pathLock: PathLock,
    opts: WriteJournalOptions = {},
  ) {
    this.rotationThreshold = opts.rotationThresholdBytes ?? ROTATION_THRESHOLD_BYTES;
    this.rotationKeepLines = opts.rotationKeepLines ?? ROTATION_KEEP_LINES;
  }

  async append(entry: JournalEntry): Promise<void> {
    await this.pathLock.with(this.relPath, async () => {
      const line = JSON.stringify(entry) + "\n";
      const exists = await this.vault.adapter.exists(this.relPath);
      if (!exists) {
        await this.vault.adapter.write(this.relPath, line);
        return;
      }
      const current = await this.vault.adapter.read(this.relPath);
      const next = current + line;
      if (next.length > this.rotationThreshold) {
        await this.rotate(next);
      } else {
        await this.vault.adapter.write(this.relPath, next);
      }
    });
  }

  /**
   * メイン journal が閾値を超えたら、古い行を archive に切り出し、
   * 直近 ROTATION_KEEP_LINES 行だけメインに残す。
   * codex review 反映: readLast/readAll の OOM を抑える。
   */
  private async rotate(combined: string): Promise<void> {
    const lines = combined.split("\n").filter(Boolean);
    const cutoff = Math.max(0, lines.length - this.rotationKeepLines);
    if (cutoff === 0) {
      // 行数は少ないがバイト数だけ大きい (1 entry が異常に長い) → そのまま書く
      await this.vault.adapter.write(this.relPath, combined);
      return;
    }
    const toArchive = lines.slice(0, cutoff);
    const toKeep = lines.slice(cutoff);
    const archivePath = this.buildArchivePath();
    await this.vault.adapter.write(archivePath, toArchive.join("\n") + "\n");
    await this.vault.adapter.write(this.relPath, toKeep.join("\n") + "\n");
    console.log(
      `[kanban] journal rotated: archived ${toArchive.length} entries -> ${archivePath}, kept ${toKeep.length}`,
    );
  }

  private buildArchivePath(): string {
    const d = new Date();
    const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    this.archiveCounter += 1;
    // counter で同一秒内の連続 rotation でもファイル名衝突を回避
    // 例: 秘書/tasks/.kanban-journal.archive.20260511_122500-1.jsonl
    return `${this.relPath}.archive.${ymd}_${hms}-${this.archiveCounter}.jsonl`;
  }

  async readAll(): Promise<JournalEntry[]> {
    const exists = await this.vault.adapter.exists(this.relPath);
    if (!exists) return [];
    const text = await this.vault.adapter.read(this.relPath);
    const entries: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // 壊れた行はスキップ（読み取りは best-effort）
      }
    }
    return entries;
  }

  /**
   * 末尾 N 件のみ取得（review security#Minor: OOM 対策）。
   * 大規模 journal で全件展開を避けたい場合に使う。Phase 4 rollback でも有用。
   */
  async readLast(n: number): Promise<JournalEntry[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
