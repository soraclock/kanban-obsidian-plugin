import type { App, TFile } from "obsidian";
import { parseFile, stringifyFile } from "./Frontmatter";
import type { Task } from "./Task";
import { parseRecurrence, nextDueDate } from "./Recurrence";
import { PathLock } from "./PathLock";
import { isSafeRelativePath } from "./TaskWriter";
import { sha256 } from "./ContentHash";
import type { SelfWriteTracker } from "./SelfWriteTracker";

/**
 * 定期タスクの「今回分を完了」処理。
 *
 * モデル変更（旧: 完了で子 spawn / 新: 親常駐 + 履歴インスタンス生成）:
 * - 親（status=定期）はそのまま列に残り、due を次回に更新、subtasks は全 unchecked にリセット
 * - 履歴インスタンスを別 ID (K-NNNN) の独立ファイルとして作る (status=完了 / recurrence=null / completedAt=今日)
 *   → 完了タブで月別に「定期タスクで何を達成したか」を確認できる
 * - 履歴ファイル名: `K-NNNN-<slug>-YYYY-MM-DD.md` で日付サフィックスを付ける（同月内の複数完了でも衝突回避）
 * - ID 採番: `_README.md` の「次のID: K-NNNN」を read → +1 して write back
 * - 親更新 + 履歴作成 + _README.md 更新 は PathLock 経由で直列化
 */
export interface SpawnResult {
  newId: string;
  newFilePath: string;
  newDue: string;
}

const NEXT_ID_RE = /次のID:\s*\*\*K-(\d{4})\*\*/;
const FILE_NAME_RE = /^K-(\d{4})-(.+)\.md$/;

export class RecurrenceSpawner {
  constructor(
    private readonly app: App,
    private readonly tasksDir: string,
    private readonly pathLock: PathLock,
    private readonly selfWriteTracker?: SelfWriteTracker,
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

    const baseStr = source.due ?? completedAt;
    const base = new Date(baseStr + "T00:00:00");
    if (Number.isNaN(base.getTime())) return null;
    const newDue = nextDueDate(rec, base);

    const readmePath = `${this.tasksDir}/_README.md`;
    return this.pathLock.with(readmePath, async () => {
      // 1. _README.md から次の ID を取得
      const readmeFile = this.getTFile(readmePath);
      const readmeText = await this.app.vault.read(readmeFile);
      const m = readmeText.match(NEXT_ID_RE);
      if (!m) {
        throw new Error("[recurrence] _README.md の次のID が見つかりません");
      }
      let next = parseInt(m[1]!, 10);

      // 2. 衝突しない ID を探索 (最大 100 回)。履歴は日付サフィックスを付けて同月複数回の衝突も回避。
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
        if (!(await this.app.vault.adapter.exists(candidatePath))) break;
        next += 1;
        tries += 1;
        if (tries > 100) throw new Error("[recurrence] ID 採番が 100 回連続で衝突");
      }

      // 3. 履歴インスタンスを作成 (status=完了, recurrence=null, completedAt=今日)
      const historyContent = buildHistoryTaskContent(source, candidateId, completedAt);
      await this.app.vault.create(candidatePath, historyContent);
      // VaultWatcher の echo 二重発火を防ぐため、新規作成ファイルも SelfWriteTracker に登録
      this.selfWriteTracker?.markSelf(candidatePath, sha256(historyContent));

      // 4. 親ファイルの due / subtasks / updated を更新 (status は「定期」のまま)。
      // 親 path も PathLock で直列化して外部 write との衝突を最小化する。
      await this.pathLock.with(source.filePath, () =>
        this.updateParentTask(source.filePath, newDue, completedAt),
      );

      // 5. _README.md の次のID を更新
      const updatedReadme = readmeText.replace(
        NEXT_ID_RE,
        `次のID: **K-${String(next + 1).padStart(4, "0")}**`,
      );
      await this.app.vault.modify(readmeFile, updatedReadme);

      return { newId: candidateId, newFilePath: candidatePath, newDue };
    });
  }

  /**
   * 旧 API 互換 (Card.tsx / DetailPane.tsx での移行期間)。
   * status=定期 のタスクなら新モデル (履歴 + 親更新) を実行、それ以外は null を返す。
   * 旧モデル（完了→子 spawn）は v0.2.0 で撤廃した。
   */
  async spawnIfRecurring(source: Task, completedAt: string): Promise<SpawnResult | null> {
    if (source.status !== "定期") return null;
    return this.completeRecurringInstance(source, completedAt);
  }

  private async updateParentTask(filePath: string, newDue: string, today: string): Promise<void> {
    const file = this.getTFile(filePath);
    const before = await this.app.vault.read(file);
    const parsed = parseFile(before);
    const data: Record<string, unknown> = { ...parsed.data };
    data.due = newDue;
    data.updated = today;
    // status=定期 のまま、completedAt は親には書かない (履歴側に記録)
    // subtasks を本文中で全 unchecked に戻す
    const resetBody = parsed.content.replace(/(-\s*\[)[xX](\])/g, "$1 $2");
    const newContent = stringifyFile(resetBody, data);
    await this.app.vault.modify(file, newContent);
    // VaultWatcher の自己 write echo を抑止して二重 reload を防ぐ
    this.selfWriteTracker?.markSelf(filePath, sha256(newContent));
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
    // サニタイズ: 許可文字以外を `-` に置換し、64 文字に切る
    const sanitized = raw.replace(/[^A-Za-z0-9_\-ぁ-んァ-ヶ一-龥]/g, "-").slice(0, 64);
    return sanitized.length > 0 ? sanitized : null;
  }
}

/**
 * 履歴インスタンスの content を作る。
 * - status: 完了
 * - completedAt: 今日
 * - recurrence: null (履歴は繰り返さない)
 * - due: 親と同じ（その回の予定だった日付）
 * - subtasks: 親と同じ状態（完了時点の記録）
 * - recurringHistoryOf: 親の ID (完了タブで視覚マーキングに使う)
 */
export function buildHistoryTaskContent(
  source: Task,
  newId: string,
  completedAt: string,
): string {
  const data: Record<string, unknown> = {
    id: newId,
    title: source.title,
    status: "完了",
    assignee: source.assignee,
    priority: source.priority,
    due: source.due ?? null,
    model: source.model ?? null,
    created: completedAt,
    updated: completedAt,
    tags: source.tags,
    related: source.related ?? [],
    completedAt,
    estimateHours: (source as unknown as { estimateHours?: number | null }).estimateHours ?? null,
    actualHours: (source as unknown as { actualHours?: number | null }).actualHours ?? null,
    recurrence: null,
    // 履歴インスタンスのマーカー（完了タブで定期履歴を区別表示するため）
    recurringHistoryOf: source.id,
  };
  return stringifyFile(source.bodyMarkdown, data);
}
