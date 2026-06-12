import type { App, TFile } from "obsidian";
import { parseFile, stringifyFile, type FrontmatterFile } from "./Frontmatter";
import { PathLock } from "./PathLock";
import { WriteJournal, type JournalEntry } from "./WriteJournal";
import { sha256, ConflictError } from "./ContentHash";
import { MAX_FILE_SIZE_BYTES, DANGEROUS_FRONTMATTER_KEYS } from "./Constants";
import {
  STATUS_VALUES,
  PRIORITY_VALUES,
  type Status,
  type Priority,
  type TaskFrontmatter,
} from "./TaskSchema";
import { isValidRecurrenceSpec } from "./Recurrence";
import { isValidDate } from "../util/dateFormat";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { ProcessLock } from "./ProcessLock";

/**
 * Phase 3 DetailPane で編集可能な frontmatter フィールドの allowlist。
 * AI tool calling 経由でも書き込まれる可能性に備え、許可フィールド以外は無視する。
 * (Phase 5c の write AI でもこの allowlist を流用)
 */
const EDITABLE_FRONTMATTER_KEYS = [
  "title",
  "status",
  "assignee",
  "priority",
  "due",
  "model",
  "tags",
  "related",
  "order",
  // Phase 4 リッチメタ (optional)
  "completedAt",
  "estimateHours",
  "actualHours",
  // Phase 7 定期タスク
  "recurrence",
] as const;
type EditableKey = (typeof EDITABLE_FRONTMATTER_KEYS)[number];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * status の runtime allowlist 検証 (review security#Major 反映、Phase 5c 先回り)。
 * TypeScript 型 `Status` は AI tool calling 経由で JSON deserialize されると無効化されるため、
 * 値レベルの検証を入口で必ず通す。
 */
export function assertValidStatus(s: string): asserts s is Status {
  if (!(STATUS_VALUES as readonly string[]).includes(s)) {
    throw new Error(`invalid status: ${s}`);
  }
}

export interface WriteResult {
  newHash: string;
}

/**
 * Phase 2 の write API。Phase 3 で DetailPane 編集を載せる際にも使う。
 *
 * 設計:
 * - EnvironmentGate readOnly チェック: 全 public write メソッドの入口で assertWritable()
 *   を呼び、readOnly モードでは throw して fail closed する
 * - ProcessLock: プロセス間排他。全 write を withProcessLock() で囲み、
 *   acquire → write → release (finally) で保証する。モバイルでは skip (ProcessLock 未設定)
 * - PathLock.with(path) で同一ファイルへの Plugin 内並行 write を直列化
 * - 直前 read で hash 取得、expectedHash と一致確認（楽観的並行制御）
 * - 一致しない場合は ConflictError throw
 * - 全メソッドで parseFile → frontmatter 変更 → stringifyFile → 単一 vault.modify の
 *   統一パターンを使用。processFrontMatter は使わない (TOCTOU window 排除)
 * - 成功後に WriteJournal に append (before/after hash + 値の snapshot)
 *
 * Phase 5c で AI write を追加する際は、TaskWriter を直接呼ばず、
 * ToolRouter が plan → diff preview → user approve → apply の中で呼ぶ。
 */
export class TaskWriter {
  constructor(
    private readonly app: App,
    private readonly pathLock: PathLock,
    private readonly journal: WriteJournal,
    private readonly selfWriteTracker?: SelfWriteTracker,
    private readonly isWriteAllowed?: () => boolean,
    private readonly processLock?: ProcessLock,
  ) {}

  /**
   * readOnly モードでは書き込みを拒否する (fail closed)。
   * EnvironmentGate が readOnly を返している場合、warn ではなく throw で止める。
   */
  private assertWritable(): void {
    if (this.isWriteAllowed && !this.isWriteAllowed()) {
      throw new Error("write rejected: plugin is in readOnly mode (EnvironmentGate)");
    }
  }

  /**
   * ProcessLock acquire → fn 実行 → release を finally で保証するヘルパー。
   * ProcessLock が未設定（モバイル等）の場合は fn をそのまま実行する。
   */
  private async withProcessLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.processLock) return fn();
    const acquired = await this.processLock.acquire();
    if (!acquired) {
      throw new Error("write rejected: failed to acquire ProcessLock (timeout)");
    }
    try {
      return await fn();
    } finally {
      await this.processLock.release();
    }
  }

  async updateStatus(
    filePath: string,
    expectedHash: string,
    newStatus: Status,
    actor: JournalEntry["actor"] = "user",
  ): Promise<WriteResult> {
    assertValidStatus(newStatus);
    this.assertWritable();
    return this.withProcessLock(() =>
      this.pathLock.with(filePath, async () => {
        const file = this.getTFile(filePath);
        const before = await this.app.vault.read(file);
        const beforeHash = sha256(before);
        if (beforeHash !== expectedHash) {
          throw new ConflictError(
            `content hash mismatch for ${filePath}`,
            filePath,
            expectedHash,
            beforeHash,
          );
        }

        const parsed = parseFile(before);
        const beforeStatus = typeof parsed.data.status === "string" ? parsed.data.status : undefined;
        const newData: Record<string, unknown> = { ...parsed.data };
        newData.status = newStatus;
        newData.updated = todayYmd();
        normalizeFrontmatterDataRecord(newData);

        const newContent = stringifyFile(parsed.content, newData);
        await this.app.vault.modify(file, newContent);

        const after = await this.app.vault.read(file);
        const afterHash = sha256(after);

        await this.journal.append({
          ts: new Date().toISOString(),
          op: "updateStatus",
          path: filePath,
          beforeHash,
          afterHash,
          actor,
          approved: true,
          beforeData: { status: beforeStatus },
          afterData: { status: newStatus },
        });

        this.selfWriteTracker?.markSelf(filePath, afterHash);
        return { newHash: afterHash };
      }),
    );
  }

  async updateOrder(
    filePath: string,
    expectedHash: string,
    newOrder: number,
    actor: JournalEntry["actor"] = "user",
  ): Promise<WriteResult> {
    this.assertWritable();
    return this.withProcessLock(() =>
      this.pathLock.with(filePath, async () => {
        const file = this.getTFile(filePath);
        const before = await this.app.vault.read(file);
        const beforeHash = sha256(before);
        if (beforeHash !== expectedHash) {
          throw new ConflictError(
            `content hash mismatch for ${filePath}`,
            filePath,
            expectedHash,
            beforeHash,
          );
        }

        const parsed = parseFile(before);
        const beforeOrder = typeof parsed.data.order === "number" ? parsed.data.order : undefined;
        const newData: Record<string, unknown> = { ...parsed.data };
        newData.order = newOrder;
        newData.updated = todayYmd();
        normalizeFrontmatterDataRecord(newData);

        const newContent = stringifyFile(parsed.content, newData);
        await this.app.vault.modify(file, newContent);

        const after = await this.app.vault.read(file);
        const afterHash = sha256(after);

        await this.journal.append({
          ts: new Date().toISOString(),
          op: "updateOrder",
          path: filePath,
          beforeHash,
          afterHash,
          actor,
          approved: true,
          beforeData: { order: beforeOrder },
          afterData: { order: newOrder },
        });

        this.selfWriteTracker?.markSelf(filePath, afterHash);
        return { newHash: afterHash };
      }),
    );
  }

  /** status + order の同時更新（列間ドラッグ＋同列順序の同期）*/
  async updateStatusAndOrder(
    filePath: string,
    expectedHash: string,
    newStatus: Status,
    newOrder: number,
    actor: JournalEntry["actor"] = "user",
  ): Promise<WriteResult> {
    assertValidStatus(newStatus);
    this.assertWritable();
    return this.withProcessLock(() =>
      this.pathLock.with(filePath, async () => {
        const file = this.getTFile(filePath);
        const before = await this.app.vault.read(file);
        const beforeHash = sha256(before);
        if (beforeHash !== expectedHash) {
          throw new ConflictError(
            `content hash mismatch for ${filePath}`,
            filePath,
            expectedHash,
            beforeHash,
          );
        }

        const parsed = parseFile(before);
        const beforeStatus = typeof parsed.data.status === "string" ? parsed.data.status : undefined;
        const beforeOrder = typeof parsed.data.order === "number" ? parsed.data.order : undefined;
        const newData: Record<string, unknown> = { ...parsed.data };
        newData.status = newStatus;
        newData.order = newOrder;
        newData.updated = todayYmd();
        normalizeFrontmatterDataRecord(newData);

        const newContent = stringifyFile(parsed.content, newData);
        await this.app.vault.modify(file, newContent);

        const after = await this.app.vault.read(file);
        const afterHash = sha256(after);

        await this.journal.append({
          ts: new Date().toISOString(),
          op: "updateFrontmatter",
          path: filePath,
          beforeHash,
          afterHash,
          actor,
          approved: true,
          beforeData: { status: beforeStatus, order: beforeOrder },
          afterData: { status: newStatus, order: newOrder },
        });

        this.selfWriteTracker?.markSelf(filePath, afterHash);
        return { newHash: afterHash };
      }),
    );
  }

  /**
   * Phase 3: DetailPane から frontmatter (任意フィールド) + 本文を同時更新。
   *
   * 設計:
   * - allowlist で許可された frontmatter フィールドのみ patch.frontmatter から反映
   *   (DetailPane 側 / AI 側どちらの呼び出しでも未知キー混入を防ぐ)
   * - status は assertValidStatus、priority は allowlist、日付は ISO 形式チェック
   * - 本文は string をそのまま書き戻し (Markdown sanitize は行わない — vault は trusted)
   * - PathLock + sha256 hash 検証 + WriteJournal append は既存 update* と同じ規約
   * - **codex review#3 反映**: 旧実装は processFrontMatter → re-read → vault.modify の
   *   多段で外部編集が割り込む race があった。gray-matter で frontmatter を本文と
   *   同時に組み立てて **単一 vault.modify** で書き込む方針に変更。frontmatter の
   *   YAML 整形は js-yaml の dump 結果になるため、quote / ordering は元の体裁から
   *   ずれる可能性がある (Phase 3 のインタラクティブ編集では許容)。
   * - **codex review#7 反映**: bodyMarkdown のサイズ上限 (MAX_FILE_SIZE_BYTES) を追加。
   *   保存後に repository が読み込めなくなる DoS を防ぐ。
   */
  async updateTask(
    filePath: string,
    expectedHash: string,
    patch: { frontmatter?: Partial<TaskFrontmatter>; bodyMarkdown?: string },
    actor: JournalEntry["actor"] = "user",
  ): Promise<WriteResult> {
    this.assertWritable();
    // patch.frontmatter は実行時 (AI 経由 含む) に来る可能性があるので、ここで検証
    const sanitizedFm = sanitizeFrontmatterPatch(patch.frontmatter);

    // bodyMarkdown のサイズ上限 (UTF-8 byte) — codex Major#7 反映
    if (patch.bodyMarkdown !== undefined) {
      const size = new TextEncoder().encode(patch.bodyMarkdown).byteLength;
      if (size > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `bodyMarkdown size ${size} exceeds limit ${MAX_FILE_SIZE_BYTES}`,
        );
      }
    }

    return this.withProcessLock(() => this.pathLock.with(filePath, async () => {
      const file = this.getTFile(filePath);
      const before = await this.app.vault.read(file);
      const beforeHash = sha256(before);
      if (beforeHash !== expectedHash) {
        throw new ConflictError(
          `content hash mismatch for ${filePath}`,
          filePath,
          expectedHash,
          beforeHash,
        );
      }

      // frontmatter + body を 1 回でビルド → 単一 vault.modify
      let parsed: FrontmatterFile;
      try {
        parsed = parseFile(before);
      } catch (e) {
        throw new Error(`frontmatter parse failed: ${(e as Error).message}`);
      }
      const beforeData: Record<string, unknown> = {};
      for (const k of EDITABLE_FRONTMATTER_KEYS) {
        beforeData[k] = (parsed.data as Record<string, unknown>)[k];
      }
      const newData: Record<string, unknown> = { ...parsed.data };
      for (const k of DANGEROUS_FRONTMATTER_KEYS) {
        delete newData[k];
      }
      for (const [k, v] of Object.entries(sanitizedFm)) {
        newData[k] = v;
      }
      newData.updated = todayYmd();

      const newBody = patch.bodyMarkdown !== undefined ? patch.bodyMarkdown : parsed.content;
      const newContent = stringifyFile(newBody, newData);
      // codex round 2 追加 Major: frontmatter 込みの総ファイルサイズも上限チェック
      // (tags/related 等で 1MB 超過すると repository が skip し UI から消える DoS を防ぐ)
      const totalSize = new TextEncoder().encode(newContent).byteLength;
      if (totalSize > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `task file size ${totalSize} exceeds limit ${MAX_FILE_SIZE_BYTES}`,
        );
      }
      await this.app.vault.modify(file, newContent);

      const after = await this.app.vault.read(file);
      const afterHash = sha256(after);

      await this.journal.append({
        ts: new Date().toISOString(),
        op: "updateTask",
        path: filePath,
        beforeHash,
        afterHash,
        actor,
        approved: true,
        beforeData,
        afterData: {
          ...sanitizedFm,
          bodyMarkdown: patch.bodyMarkdown !== undefined ? "(changed)" : undefined,
        },
      });

      this.selfWriteTracker?.markSelf(filePath, afterHash);
      return { newHash: afterHash };
    }));
  }

  /**
   * Phase 3: アーカイブフォルダへ移動 (delete は廃止、archive のみ)。
   * `<tasksDir>/_archive/<original-filename>` へ rename。
   *
   * codex review 反映:
   * - **Major#4**: expectedHash を必須化。古い UI 表示でアーカイブする操作を防ぐ。
   * - **Major#5**: tasksDir / filePath の path validation (`..` / 絶対パス / 範囲外)。
   *   AI write 等から writer が直呼びされる将来に備えた境界防御。
   */
  async archive(
    filePath: string,
    tasksDir: string,
    expectedHash: string,
    actor: JournalEntry["actor"] = "user",
  ): Promise<{ archivePath: string }> {
    this.assertWritable();
    // path validation (vault 相対の安全な path 形式に限定)
    if (!isSafeRelativePath(tasksDir)) throw new Error(`invalid tasksDir: ${tasksDir}`);
    if (!isSafeRelativePath(filePath)) throw new Error(`invalid filePath: ${filePath}`);
    if (!filePath.startsWith(tasksDir + "/")) {
      throw new Error(`archive path outside tasks dir: ${filePath}`);
    }
    if (filePath.startsWith(tasksDir + "/_archive/")) {
      throw new Error(`already archived: ${filePath}`);
    }

    return this.withProcessLock(() => this.pathLock.with(filePath, async () => {
      const file = this.getTFile(filePath);
      const before = await this.app.vault.read(file);
      const beforeHash = sha256(before);
      if (beforeHash !== expectedHash) {
        throw new ConflictError(
          `content hash mismatch for ${filePath}`,
          filePath,
          expectedHash,
          beforeHash,
        );
      }

      // Phase 7: アーカイブは `_archive/YYYY-MM/` の月別構造に
      const now = new Date();
      const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const archiveDir = `${tasksDir}/_archive/${yyyymm}`;
      // 親 `_archive/` と月ディレクトリの両方を作成 (createFolder は親無しで失敗するため階層的に)
      const parentArchive = `${tasksDir}/_archive`;
      if (!(await this.app.vault.adapter.exists(parentArchive))) {
        await this.app.vault.createFolder(parentArchive);
      }
      if (!(await this.app.vault.adapter.exists(archiveDir))) {
        await this.app.vault.createFolder(archiveDir);
      }
      const fileName = filePath.split("/").pop()!;
      const archivePath = `${archiveDir}/${fileName}`;
      // 名前衝突回避 (同 ID 再アーカイブなど)
      let finalPath = archivePath;
      if (await this.app.vault.adapter.exists(finalPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        finalPath = `${archiveDir}/${fileName.replace(/\.md$/, "")}-${ts}.md`;
      }

      await this.app.vault.rename(file, finalPath);

      await this.journal.append({
        ts: new Date().toISOString(),
        op: "archive",
        path: filePath,
        beforeHash,
        afterHash: beforeHash, // 内容変更なし
        actor,
        approved: true,
        beforeData: { from: filePath },
        afterData: { to: finalPath },
      });

      return { archivePath: finalPath };
    }));
  }

  /**
   * v0.3.0: タスクファイルを OS ゴミ箱に送る (誤削除でも OS のゴミ箱から復元可能)。
   * - expectedHash で楽観的並行制御
   * - PathLock で他 write と直列化
   * - Obsidian の `vault.trash(file, system=true)` を使用 (OS ゴミ箱、vault.delete よりも安全)
   * - Journal に op="deleteTask" を append
   */
  async deleteTask(
    filePath: string,
    tasksDir: string,
    expectedHash: string,
    actor: JournalEntry["actor"] = "user",
  ): Promise<void> {
    this.assertWritable();
    if (!isSafeRelativePath(tasksDir)) throw new Error(`invalid tasksDir: ${tasksDir}`);
    if (!isSafeRelativePath(filePath)) throw new Error(`invalid filePath: ${filePath}`);
    if (!filePath.startsWith(tasksDir + "/")) {
      throw new Error(`delete path outside tasks dir: ${filePath}`);
    }
    return this.withProcessLock(() => this.pathLock.with(filePath, async () => {
      const file = this.getTFile(filePath);
      const before = await this.app.vault.read(file);
      const beforeHash = sha256(before);
      if (beforeHash !== expectedHash) {
        throw new ConflictError(
          `content hash mismatch for ${filePath}`,
          filePath,
          expectedHash,
          beforeHash,
        );
      }

      // OS のゴミ箱に送る (system=true)。誤削除でも OS 側で復元可能。
      await this.app.vault.trash(file, true);

      await this.journal.append({
        ts: new Date().toISOString(),
        op: "deleteTask",
        path: filePath,
        beforeHash,
        afterHash: beforeHash, // ファイルは消えるが、操作前 hash を記録
        actor,
        approved: true,
        beforeData: { from: filePath },
        afterData: { trashed: true },
      });
    }));
  }

  /**
   * Phase 7: アーカイブから tasks/ 直下へ復元する (rename only)。
   * - archivedPath は `<tasksDir>/_archive/...` 配下である必要がある
   * - ファイル名 (K-NNNN-...) を取り出し `<tasksDir>/{fileName}` に rename
   * - 同名衝突時は timestamp suffix を付与
   * - 内容変更なし、journal に op: "restore" を記録
   */
  async restore(
    archivedPath: string,
    tasksDir: string,
    actor: JournalEntry["actor"] = "user",
  ): Promise<{ restoredPath: string }> {
    this.assertWritable();
    if (!isSafeRelativePath(tasksDir)) throw new Error(`invalid tasksDir: ${tasksDir}`);
    if (!isSafeRelativePath(archivedPath)) throw new Error(`invalid archivedPath: ${archivedPath}`);
    if (!archivedPath.startsWith(tasksDir + "/_archive/")) {
      throw new Error(`restore source must be inside _archive: ${archivedPath}`);
    }
    return this.withProcessLock(() => this.pathLock.with(archivedPath, async () => {
      const file = this.getTFile(archivedPath);
      const before = await this.app.vault.read(file);
      const beforeHash = sha256(before);

      const fileName = archivedPath.split("/").pop()!;
      let restoredPath = `${tasksDir}/${fileName}`;
      if (await this.app.vault.adapter.exists(restoredPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        restoredPath = `${tasksDir}/${fileName.replace(/\.md$/, "")}-restored-${ts}.md`;
      }
      await this.app.vault.rename(file, restoredPath);

      await this.journal.append({
        ts: new Date().toISOString(),
        op: "restore",
        path: archivedPath,
        beforeHash,
        afterHash: beforeHash,
        actor,
        approved: true,
        beforeData: { from: archivedPath },
        afterData: { to: restoredPath },
      });

      // restore 先は VaultWatcher の reload 対象 (tasks/ 直下) なので markSelf
      this.selfWriteTracker?.markSelf(restoredPath, beforeHash);
      return { restoredPath };
    }));
  }

  private getTFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new Error(`file not found: ${filePath}`);
    // duck typing: TFile interface
    if (!("stat" in file)) throw new Error(`not a file: ${filePath}`);
    return file as TFile;
  }
}

/**
 * 受け取った frontmatter patch を allowlist + 型チェック付きで正規化する。
 * 未知キー・型不正な値は静かに drop (DetailPane 側で UI バリデーション、ここは最終防衛線)。
 *
 * codex review#6 反映: `k in patch` は prototype chain も見るため、悪意ある prototype 上の
 * allowlist key を拾うリスクがある。`hasOwnProperty.call` で自前 own property のみ採用。
 *
 * unit テストから直接呼べるよう export。
 */
export function sanitizeFrontmatterPatch(
  patch: Partial<TaskFrontmatter> | undefined,
): Partial<Record<EditableKey, unknown>> {
  if (!patch) return {};
  const out: Partial<Record<EditableKey, unknown>> = {};
  for (const k of EDITABLE_FRONTMATTER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === "status") {
      if (typeof v !== "string" || !(STATUS_VALUES as readonly string[]).includes(v)) continue;
    } else if (k === "priority") {
      if (typeof v !== "string" || !(PRIORITY_VALUES as readonly string[]).includes(v)) continue;
    } else if (k === "due" || k === "completedAt") {
      if (v !== null && (typeof v !== "string" || !ISO_DATE_RE.test(v) || !isValidDate(v))) continue;
    } else if (k === "model") {
      if (v !== null && !(typeof v === "string" && ["opus", "sonnet", "haiku"].includes(v))) continue;
    } else if (k === "tags" || k === "related") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) continue;
      // DoS 防御: 配列は最大 256 要素、各要素は最大 512 文字
      const filtered = (v as string[]).filter((x) => x.length <= 512).slice(0, 256);
      out[k] = filtered;
      continue;
    } else if (k === "title" || k === "assignee") {
      if (typeof v !== "string") continue;
      // DoS 防御: 最大 2048 文字を超えたら drop
      if (v.length > 2048) continue;
      // title は schema 必須 (min 1)。空・空白のみは drop
      // (frontmatter に title: "" が書かれると schema audit エラー + ボードから消える)
      if (k === "title" && v.trim().length === 0) continue;
    } else if (k === "order") {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
    } else if (k === "estimateHours" || k === "actualHours") {
      if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) continue;
    } else if (k === "recurrence") {
      // null or 有効な書式の文字列のみ通す
      if (v !== null && (typeof v !== "string" || !isValidRecurrenceSpec(v))) continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * vault 相対パスとして安全な形式か検証する (codex review#5 反映)。
 * - 絶対パス (`/...` で始まる) を弾く
 * - `..` セグメントを弾く (path traversal 防止)
 * - 空文字を弾く
 * - 制御文字 / バックスラッシュ等を弾く (Windows / 不正文字対策)
 *
 * unit テストから直接呼べるよう export。
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/[ -]/.test(p)) return false;
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.includes("\\")) return false;
  }
  return true;
}

/**
 * frontmatter `---\n...\n---\n` と本文を分割。delimiter 部分は fmRaw に含む。
 * frontmatter が無いファイルは fmRaw = ''、body = 全体。
 *
 * unit テストから直接呼べるよう export。
 */
export function splitFrontmatterAndBody(content: string): { fmRaw: string; body: string } {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!m) return { fmRaw: "", body: content };
  return { fmRaw: m[0], body: content.slice(m[0].length) };
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 日付フィールドの正規化対象キー。 */
const NORMALIZED_DATE_FIELDS = ["created", "updated", "due", "completedAt"] as const;

/**
 * parseFile 経由のデータレコードに対する日付正規化。
 * parseFile は内部で normalizeDateValues を回すため本来不要だが、
 * 万一 Date が残っているケースの保険として updateStatus/updateOrder 等で呼ぶ。
 */
function normalizeFrontmatterDataRecord(fm: Record<string, unknown>): void {
  normalizeFrontmatterDates(fm);
}

/**
 * Date / ISO 8601 文字列を YYYY-MM-DD に正規化。
 * 値が null / undefined / 既に YYYY-MM-DD 文字列ならそのまま。
 * Date の解釈は UTC（YAML parser が date-only literal を UTC midnight で生成するため）。
 */
function normalizeFrontmatterDates(fm: Record<string, unknown>): void {
  for (const k of NORMALIZED_DATE_FIELDS) {
    const v = fm[k];
    if (v instanceof Date && !isNaN(v.getTime())) {
      const y = v.getUTCFullYear();
      const mo = String(v.getUTCMonth() + 1).padStart(2, "0");
      const day = String(v.getUTCDate()).padStart(2, "0");
      fm[k] = `${y}-${mo}-${day}`;
    } else if (typeof v === "string") {
      // 先頭 YYYY-MM-DD だけ抽出（"2026-05-03T00:00:00.000Z" → "2026-05-03"）
      const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] !== v) fm[k] = m[1];
    }
  }
}
