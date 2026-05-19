import type { TaskFrontmatter, Status, Priority } from "./TaskSchema";

export type { Status, Priority };

export interface Subtask {
  text: string;
  checked: boolean;
}

/**
 * Plugin 内部表現。frontmatter + filePath + body + 解析済みサブタスク。
 * Phase 1 では read-only。
 */
export interface Task extends TaskFrontmatter {
  filePath: string;
  /** 楽観的並行制御用の content sha256。write 時に expectedHash として渡す */
  contentHash: string;
  bodyMarkdown: string;
  subtasks: Subtask[];
}
