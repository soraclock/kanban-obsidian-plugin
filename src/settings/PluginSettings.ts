import { DEFAULT_TASKS_DIR } from "../data/Constants";

/**
 * Plugin の永続設定。data.json に保存される。
 *
 * tasksDir: vault 内のタスクフォルダパス。スラッシュ区切りの相対パス。
 * tagOrder: タグの表示順。FilterBar 等で利用される。未登録タグは末尾。
 * tagColors: 個別タグの色（CSS color、例 "#ef6c00"）。空 = 自動色を使う。
 * autoColorEnabled: 個別指定のないタグに自動色を当てるか。
 */
export interface PluginSettings {
  tasksDir: string;
  tagOrder: string[];
  tagColors: Record<string, string>;
  autoColorEnabled: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  tasksDir: DEFAULT_TASKS_DIR,
  tagOrder: [],
  tagColors: {},
  autoColorEnabled: true,
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
