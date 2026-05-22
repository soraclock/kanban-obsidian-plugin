import type { App, TFile } from "obsidian";
import { parseFile, stringifyFile } from "./Frontmatter";
import type { Task } from "./Task";
import { parseRecurrence, nextDueDate } from "./Recurrence";
import { PathLock } from "./PathLock";
import { isSafeRelativePath } from "./TaskWriter";
import { sha256, ConflictError } from "./ContentHash";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { WriteJournal } from "./WriteJournal";
import type { OperationHistory } from "./OperationHistory";

/**
 * 定期タスクの「今回分を完了」処理。
 *
 * モデル（v0.2.0 以降）:
 * - 親（status=定期）はそのまま列に残り、due を次回に更新、subtasks は全 unchecked にリセット
 * - 履歴インスタンスを別 ID (K-NNNN) の独立ファイルとして作る (status=完了 / recurrence=null / completedAt=今日)
 *   → 完了タブで月別に「定期タスクで何を達成したか」を確認できる
 * - 履歴ファイル名: `K-NNNN-<slug>-YYYY-MM-DD.md`（同月内の複数完了でも衝突回避）
 * - ID 採番: vault 内の既存 K-NNNN を全てスキャンして衝突しない番号を採番
 *
 * codex review 反映 (v0.2.3):
 * - 親の hash 検証を導入し、PathLock 内で親ファイルを読み直して最新 due を基準に next を計算
 *   → 同時完了で stale due になる問題を解消
 * - 履歴 create 後の親更新/README 更新失敗時に履歴ファイルを補償削除
 *   → 履歴孤児化を防ぐ
 * - ID 衝突チェックを slug 無視で vault 内全 K-NNNN スキャンに変更
 *   → 別 slug の同 K-NNNN との ID 重複を防ぐ
 */
export interface SpawnResult {
  newId: string;
  newFilePath: string;
  newDue: string;
}

const NEXT_ID_RE = /次のID:\s*\*\*K-(\d{4})\*\*/;
const FILE_NAME_RE = /^K-(\d{4})-(.+)\.md$/;
const ID_PREFIX_RE = /^K-(\d{4})/;

export class RecurrenceSpawner {
  constructor(
    private readonly app: App,
    private readonly tasksDir: string,
    private readonly pathLock: PathLock,
    private readonly selfWriteTracker?: SelfWriteTracker,
    private readonly journal?: WriteJournal,
    private readonly history?: OperationHistory,
  ) {}

  /**
   * 定期タスクの「今回分を完了」処理。
   * 親はそのまま、履歴インスタンスを作って親の due を次回に更新する。
   */
  async completeRecurringInstance(
    source: Task,
    completedAt: string,
  ): Promise<SpawnResult | null> {
    const recRaw = (source as unknown as { recurrence?: string | null }).recurrence;
    if (!recRaw) return null;
    const rec = parseRecurrence(recRaw);
    if (!rec) return null;

    const readmePath = `${this.tasksDir}/_README.md`;
    return this.pathLock.with(readmePath, async () => {
      // 親 path も PathLock で直列化。ネスト順は readme → parent で固定（デッドロック回避）。
      return this.pathLock.with(source.filePath, async () => {
        // 1. 親ファイルを読み直して hash 検証 + 最新 due 取得 (codex Major: 同時完了で stale due 防止)
        const parentFile = this.getTFile(source.filePath);
        const parentBefore = await this.app.vault.read(parentFile);
        const parentBeforeHash = sha256(parentBefore);
        if (source.contentHash !== parentBeforeHash) {
          throw new ConflictError(
            `content hash mismatch for ${source.filePath}`,
            source.filePath,
            source.contentHash,
            parentBeforeHash,
          );
        }
        const parentParsed = parseFile(parentBefore);
        const currentDue =
          typeof parentParsed.data.due === "string" ? parentParsed.data.due : null;
        const baseStr = currentDue ?? completedAt;
        const base = new Date(baseStr + "T00:00:00");
        if (Number.isNaN(base.getTime())) return null;
        const newDue = nextDueDate(rec, base);

        // 2. _README.md から次の ID を取得
        const readmeFile = this.getTFile(readmePath);
        const readmeText = await this.app.vault.read(readmeFile);
        const m = readmeText.match(NEXT_ID_RE);
        if (!m) {
          throw new Error("[recurrence] _README.md の次のID が見つかりません");
        }
        let next = parseInt(m[1]!, 10);

        // 3. vault 内既存 K-NNNN を全てスキャンして衝突しない ID を採番
        // (codex Major: slug 違いの同 K-NNNN との ID 重複を防ぐ)
        const existingIds = await this.collectExistingIds();
        const slug = this.extractSlug(source.filePath) ?? "recurring";
        let candidateId: string;
        let candidatePath: string;
        let tries = 0;
        while (true) {
          candidateId = "K-" + String(next).padStart(4, "0");
          candidatePath = `${this.tasksDir}/${candidateId}-${slug}-${completedAt}.md`;
          if (!isSafeRelativePath(candidatePath) || !candidatePath.startsWith(this.tasksDir + "/")) {
            throw new Error(`invalid history path: ${candidatePath}`);
          }
          // ID プレフィクス全体で衝突しないこと + パス自体も存在しないことの 2 条件
          if (
            !existingIds.has(candidateId) &&
            !(await this.app.vault.adapter.exists(candidatePath))
          ) {
            break;
          }
          next += 1;
          tries += 1;
          if (tries > 1000) throw new Error("[recurrence] ID 採番が 1000 回連続で衝突");
        }

        // 4. 履歴インスタンスを作成
        const historyContent = buildHistoryTaskContent(
          source,
          candidateId,
          completedAt,
          currentDue,
        );
        await this.app.vault.create(candidatePath, historyContent);
        this.selfWriteTracker?.markSelf(candidatePath, sha256(historyContent));

        // 5. 親更新 + README 更新。失敗したら履歴ファイルを補償削除
        // (codex Major: 履歴孤児化を防ぐ)
        try {
          await this.updateParentTask(
            parentFile,
            parentParsed,
            parentBeforeHash,
            newDue,
            completedAt,
          );
          const updatedReadme = readmeText.replace(
            NEXT_ID_RE,
            `次のID: **K-${String(next + 1).padStart(4, "0")}**`,
          );
          await this.app.vault.modify(readmeFile, updatedReadme);
        } catch (e) {
          // 補償削除: 履歴ファイルを巻き戻す
          try {
            const historyFile = this.app.vault.getAbstractFileByPath(candidatePath);
            if (historyFile && "stat" in historyFile) {
              await this.app.vault.delete(historyFile as TFile);
            }
          } catch (cleanupErr) {
            console.error(
              "[recurrence] history rollback failed:",
              candidatePath,
              cleanupErr,
            );
          }
          throw e;
        }

        // 6. WriteJournal + OperationHistory に記録 (review #5: 監査証跡 + Undo)
        const ts = new Date().toISOString();
        const historyHash = sha256(historyContent);
        if (this.journal) {
          await this.journal.append({
            ts,
            op: "completeRecurring",
            path: candidatePath,
            beforeHash: "",
            afterHash: historyHash,
            actor: "user",
            approved: true,
            beforeData: undefined,
            afterData: { id: candidateId, recurringHistoryOf: source.id, completedAt },
          });
          await this.journal.append({
            ts,
            op: "completeRecurring",
            path: source.filePath,
            beforeHash: parentBeforeHash,
            afterHash: sha256(stringifyFile(
              parentParsed.content.replace(/(-\s*\[)[xX](\])/g, "$1 $2"),
              { ...(parentParsed.data as Record<string, unknown>), due: newDue, updated: completedAt },
            )),
            actor: "user",
            approved: true,
            beforeData: { due: baseStr },
            afterData: { due: newDue },
          });
        }
        this.history?.push({
          type: "recurrence",
          filePath: source.filePath,
          before: { status: source.status },
          after: { status: source.status },
          afterHash: historyHash,
          ts,
        });

        return { newId: candidateId, newFilePath: candidatePath, newDue };
      });
    });
  }

  /**
   * 旧 API 互換 (Card.tsx / DetailPane.tsx での移行期間)。
   * status=定期 のタスクなら新モデル (履歴 + 親更新) を実行、それ以外は null を返す。
   */
  async spawnIfRecurring(source: Task, completedAt: string): Promise<SpawnResult | null> {
    if (source.status !== "定期") return null;
    return this.completeRecurringInstance(source, completedAt);
  }

  /**
   * tasksDir 配下の全 K-NNNN ID を収集 (slug 違いでの ID 重複検出用)。
   * _archive 配下は除外しない（vault 全体で ID 一意を保つ）。
   */
  private async collectExistingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const files = this.app.vault.getMarkdownFiles();
    for (const f of files) {
      const name = f.path.split("/").pop() ?? "";
      const m = name.match(ID_PREFIX_RE);
      if (m) ids.add(`K-${m[1]}`);
    }
    return ids;
  }

  private async updateParentTask(
    parentFile: TFile,
    parentParsed: ReturnType<typeof parseFile>,
    expectedHash: string,
    newDue: string,
    today: string,
  ): Promise<void> {
    // hash を再度確認（PathLock 取得直後に同じ内容を読んでいるが、念のため）
    const reread = await this.app.vault.read(parentFile);
    const rereadHash = sha256(reread);
    if (rereadHash !== expectedHash) {
      throw new ConflictError(
        `content hash mismatch (parent re-read) for ${parentFile.path}`,
        parentFile.path,
        expectedHash,
        rereadHash,
      );
    }
    const data: Record<string, unknown> = {
      ...(parentParsed.data as Record<string, unknown>),
    };
    data.due = newDue;
    data.updated = today;
    // status=定期 のまま、completedAt は親には書かない (履歴側に記録)
    // subtasks を本文中で全 unchecked に戻す
    const resetBody = parentParsed.content.replace(/(-\s*\[)[xX](\])/g, "$1 $2");
    const newContent = stringifyFile(resetBody, data);
    await this.app.vault.modify(parentFile, newContent);
    this.selfWriteTracker?.markSelf(parentFile.path, sha256(newContent));
  }

  private getTFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new Error(`file not found: ${filePath}`);
    if (!("stat" in file)) throw new Error(`not a file: ${filePath}`);
    return file as TFile;
  }

  private extractSlug(filePath: string): string | null {
    const name = filePath.split("/").pop() ?? "";
    const m = name.match(FILE_NAME_RE);
    if (!m) return null;
    const raw = m[2]!;
    const sanitized = raw.replace(/[^A-Za-z0-9_\-ぁ-んァ-ヶ一-龥]/g, "-").slice(0, 64);
    return sanitized.length > 0 ? sanitized : null;
  }
}

/**
 * 履歴インスタンスの content を作る。
 * - status: 完了
 * - completedAt: 今日
 * - recurrence: null (履歴は繰り返さない)
 * - due: その回の予定だった日付 (PathLock 内で読み直した親の due)
 * - subtasks: 親と同じ状態
 * - recurringHistoryOf: 親の ID
 */
export function buildHistoryTaskContent(
  source: Task,
  newId: string,
  completedAt: string,
  currentParentDue?: string | null,
): string {
  const data: Record<string, unknown> = {
    id: newId,
    title: source.title,
    status: "完了",
    assignee: source.assignee,
    priority: source.priority,
    due: currentParentDue ?? source.due ?? null,
    model: source.model ?? null,
    created: completedAt,
    updated: completedAt,
    tags: source.tags,
    related: source.related ?? [],
    completedAt,
    estimateHours: (source as unknown as { estimateHours?: number | null }).estimateHours ?? null,
    actualHours: (source as unknown as { actualHours?: number | null }).actualHours ?? null,
    recurrence: null,
    recurringHistoryOf: source.id,
  };
  return stringifyFile(source.bodyMarkdown, data);
}
