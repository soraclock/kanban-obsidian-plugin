import type { App, TFile } from "obsidian";
import matter from "gray-matter";
import type { Task } from "./Task";
import { parseRecurrence, nextDueDate } from "./Recurrence";
import { PathLock } from "./PathLock";
import { isSafeRelativePath } from "./TaskWriter";

/**
 * Phase 7: 定期タスクの次回インスタンス自動生成。
 *
 * 設計:
 * - 完了に遷移したタスクが `recurrence` を持っていれば、次回 due の新規 K-NNNN を作る
 * - 既存 source は historical record として残す (削除しない、status=完了 のまま)
 * - 新規タスク: status=未着手 / completedAt=null / order は列末尾追加 / subtasks は全て unchecked
 * - ID 採番: `_README.md` の「次のID: K-NNNN」を read → +1 して write back
 * - 同名衝突: K-NNNN は zero-pad、衝突したら +1 再採番 (最大 100 回)
 * - _README.md と新規ファイル作成は PathLock 経由で直列化
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
  ) {}

  async spawnIfRecurring(source: Task, completedAt: string): Promise<SpawnResult | null> {
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

      // 2. 衝突しない ID を探索 (最大 100 回)
      const slug = this.extractSlug(source.filePath) ?? "recurring";
      let candidateId: string;
      let candidatePath: string;
      let tries = 0;
      while (true) {
        candidateId = "K-" + String(next).padStart(4, "0");
        candidatePath = `${this.tasksDir}/${candidateId}-${slug}.md`;
        if (!isSafeRelativePath(candidatePath) || !candidatePath.startsWith(this.tasksDir + "/")) {
          throw new Error(`invalid spawn path: ${candidatePath}`);
        }
        if (!(await this.app.vault.adapter.exists(candidatePath))) break;
        next += 1;
        tries += 1;
        if (tries > 100) throw new Error("[recurrence] ID 採番が 100 回連続で衝突");
      }

      // 3. 新規 task の frontmatter + body を構築
      const newContent = buildNewTaskContent(source, candidateId, newDue, recRaw);

      // 4. 新規ファイル作成
      await this.app.vault.create(candidatePath, newContent);

      // 5. _README.md の次のID を更新
      const updatedReadme = readmeText.replace(
        NEXT_ID_RE,
        `次のID: **K-${String(next + 1).padStart(4, "0")}**`,
      );
      await this.app.vault.modify(readmeFile, updatedReadme);

      return { newId: candidateId, newFilePath: candidatePath, newDue };
    });
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
 * source の frontmatter + body から、次回インスタンス用の content を作る。
 * - status: 未着手 にリセット
 * - due: newDue
 * - completedAt: null
 * - subtasks: 全 unchecked
 * - recurrence: 同じ書式を引き継ぎ
 * - id / filePath は新規
 * - created / updated は今日
 */
export function buildNewTaskContent(
  source: Task,
  newId: string,
  newDue: string,
  recurrenceSpec: string,
): string {
  const today = ymdLocal(new Date());
  const data: Record<string, unknown> = {
    id: newId,
    title: source.title,
    status: "未着手",
    assignee: source.assignee,
    priority: source.priority,
    due: newDue,
    model: source.model ?? null,
    created: today,
    updated: today,
    tags: source.tags,
    related: source.related ?? [],
    completedAt: null,
    estimateHours: (source as unknown as { estimateHours?: number | null }).estimateHours ?? null,
    actualHours: null, // 実績は引き継がない
    recurrence: recurrenceSpec,
  };
  // 末尾 order は呼び出し側で再 sort 不要 (新規 reload で自然に末尾になる)
  // body markdown: source の本文中の `- [x]` を `- [ ]` に置換して unchecked にする
  const resetBody = source.bodyMarkdown.replace(/(-\s*\[)[xX](\])/g, "$1 $2");
  return matter.stringify(resetBody, data);
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
