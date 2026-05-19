/**
 * Plugin 全体で参照する定数。
 * - 値の単一情報源 (review code-reviewer#Minor)
 * - SchemaAudit と TaskRepository で防御を共通化 (review security#Major)
 */

/**
 * タスクフォルダの既定パス。設定タブで上書き可能。
 * vault 直下 `tasks/` をデフォルトにすることで、新規ユーザーがゼロ設定で動かせる。
 */
export const DEFAULT_TASKS_DIR = "tasks";

export const LEGACY_KANBAN_PORT = 3001;

/** ジャーナルファイル名（tasksDir 配下に置く） */
export const JOURNAL_FILE_NAME = ".kanban-journal.jsonl";
/** ProcessLock ファイル名（tasksDir 配下に置く） */
export const LOCK_FILE_NAME = ".kanban-lock";

export function journalPathFor(tasksDir: string): string {
  return `${tasksDir}/${JOURNAL_FILE_NAME}`;
}

export function lockPathFor(tasksDir: string): string {
  return `${tasksDir}/${LOCK_FILE_NAME}`;
}

/**
 * 1 MB。SchemaAudit と TaskRepository の両方で適用。
 * 超過ファイルは read 前に skip + error。OOM / DoS 対策。
 */
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * frontmatter で許可しないキー。prototype pollution 系の防御。
 * 現行の gray-matter + js-yaml 4.x では Object.prototype 汚染にはならないが、
 * 文字列値の `__proto__` キーは Task オブジェクトに残るため、
 * 入力段階で弾く。
 */
export const DANGEROUS_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
