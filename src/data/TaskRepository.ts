import type { App, TFile } from "obsidian";
import { parseFile, type FrontmatterFile } from "./Frontmatter";
import { TaskFrontmatterSchema } from "./TaskSchema";
import { parseSubtasks } from "./Subtasks";
import type { Task } from "./Task";
import { DANGEROUS_FRONTMATTER_KEYS, MAX_FILE_SIZE_BYTES } from "./Constants";
import { sha256 } from "./ContentHash";

export interface TaskRepositoryResult {
  tasks: Task[];
  errors: Array<{ filePath: string; message: string }>;
}

/**
 * Phase 1 では read-only。Vault 内 `${tasksDir}/K-*.md` を全件 read し、
 * frontmatter を zod parse、本文の `## 次のアクション` から checkbox を解析する。
 *
 * Phase 2 以降で write API (updateStatus, updateOrder 等) を追加予定。
 * write は必ず PathLock + processFrontMatter を経由する設計。
 */
export class TaskRepository {
  constructor(
    private readonly app: App,
    private readonly tasksDir: string,
  ) {}

  async listAll(): Promise<TaskRepositoryResult> {
    const files = this.collectFiles();
    const tasks: Task[] = [];
    const errors: TaskRepositoryResult["errors"] = [];

    for (const file of files) {
      const r = await this.parseFile(file);
      if ("task" in r) tasks.push(r.task);
      else errors.push(r);
    }

    return { tasks, errors };
  }

  /**
   * Phase 3: 単一ファイル読み込み。VaultWatcher で外部変更を検知した時、
   * 全件 reload せずこの path だけ更新するために使う。
   * tasksDir 配下の K-*.md でない場合は null。
   */
  async readOne(filePath: string): Promise<Task | null> {
    if (!this.isTaskPath(filePath)) return null;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !("stat" in file)) return null;
    const r = await this.parseFile(file as TFile);
    return "task" in r ? r.task : null;
  }

  private isTaskPath(filePath: string): boolean {
    if (!filePath.startsWith(this.tasksDir + "/")) return false;
    if (filePath.startsWith(this.tasksDir + "/_archive/")) return false;
    const name = filePath.split("/").pop() ?? "";
    return name.startsWith("K-") && name.endsWith(".md");
  }

  private async parseFile(
    file: TFile,
  ): Promise<{ task: Task } | TaskRepositoryResult["errors"][number]> {
    try {
      // ファイルサイズ上限 (SchemaAudit と共通防御、review security#Major 反映)
      const size = (file as unknown as { stat?: { size?: number } }).stat?.size;
      if (typeof size === "number" && size > MAX_FILE_SIZE_BYTES) {
        return {
          filePath: file.path,
          message: `file size ${size} exceeds limit ${MAX_FILE_SIZE_BYTES} (skipped to avoid OOM)`,
        };
      }

      const content = await this.app.vault.read(file);
      let parsed: FrontmatterFile;
      try {
        parsed = parseFile(content);
      } catch (e) {
        return { filePath: file.path, message: `frontmatter parse failed: ${(e as Error).message}` };
      }

      // prototype pollution 系の危険キー検出 (review security#Major 反映)
      for (const key of Object.keys(parsed.data)) {
        if (DANGEROUS_FRONTMATTER_KEYS.has(key)) {
          return { filePath: file.path, message: `dangerous frontmatter key "${key}" rejected` };
        }
      }

      const result = TaskFrontmatterSchema.safeParse(parsed.data);
      if (!result.success) {
        return {
          filePath: file.path,
          message: `schema invalid: ${result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        };
      }

      return {
        task: {
          ...result.data,
          filePath: file.path,
          contentHash: sha256(content),
          bodyMarkdown: parsed.content,
          subtasks: parseSubtasks(parsed.content),
        },
      };
    } catch (e) {
      return { filePath: file.path, message: `read failed: ${(e as Error).message}` };
    }
  }

  private collectFiles(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter(
        (f) =>
          f.path.startsWith(this.tasksDir + "/") &&
          !f.path.startsWith(this.tasksDir + "/_archive/") &&
          f.name.startsWith("K-") &&
          f.name.endsWith(".md"),
      );
  }
}
