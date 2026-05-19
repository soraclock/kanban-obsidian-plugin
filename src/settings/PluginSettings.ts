import { DEFAULT_TASKS_DIR } from "../data/Constants";

/**
 * Plugin の永続設定。data.json に保存される。
 *
 * tasksDir: vault 内のタスクフォルダパス。スラッシュ区切りの相対パス。
 *   既定は "tasks"。配布時に他人の vault でも動くようにするため、
 *   特定のユーザー固有パス（"秘書/tasks" など）は default にしない。
 */
export interface PluginSettings {
  tasksDir: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  tasksDir: DEFAULT_TASKS_DIR,
};

/**
 * 入力値を正規化する。
 * - 前後空白除去
 * - 先頭 / 末尾の "/" を除去
 * - 空文字なら default
 * - 危険な ".." や絶対パスは default にフォールバック
 */
export function normalizeTasksDir(input: unknown): string {
  if (typeof input !== "string") return DEFAULT_TASKS_DIR;
  let v = input.trim();
  v = v.replace(/^\/+/, "").replace(/\/+$/, "");
  if (v === "") return DEFAULT_TASKS_DIR;
  if (v.includes("..")) return DEFAULT_TASKS_DIR;
  if (v.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(v)) return DEFAULT_TASKS_DIR;
  return v;
}
