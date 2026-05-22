import { DEFAULT_TASKS_DIR } from "../data/Constants";

/**
 * Plugin の永続設定。data.json に保存される。
 *
 * tasksDir: vault 内のタスクフォルダパス。スラッシュ区切りの相対パス。
 * tagOrder: タグの表示順。FilterBar 等で利用される。未登録タグは末尾。
 * tagColors: 個別タグの色（CSS color、例 "#ef6c00"）。空 = 自動色を使う。
 * autoColorEnabled: 個別指定のないタグに自動色を当てるか。
 * attachmentDir: 画像 / PDF 添付の保存先。空文字 = `<tasksDir>/_attachments` を既定として使う。
 *   v0.5.1: vault ルートに添付ファイルが散らばるのを防ぐ専用フォルダ。
 * defaultAssignee: 新規タスク作成時の既定の担当者、および FilterBar の「担当」チップ並び順で
 *   先頭固定する自分の名前。空文字なら未設定扱い（TaskCreator は空文字を入れる / FilterBar は件数順のみ）。
 *   v0.6.6: TaskCreator のハードコード「花木」を廃止して設定値に集約。
 */
export interface PluginSettings {
  tasksDir: string;
  tagOrder: string[];
  tagColors: Record<string, string>;
  autoColorEnabled: boolean;
  attachmentDir: string;
  defaultAssignee: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  tasksDir: DEFAULT_TASKS_DIR,
  tagOrder: [],
  tagColors: {},
  autoColorEnabled: true,
  attachmentDir: "",
  defaultAssignee: "",
};

/**
 * attachmentDir 設定値を解決して、実際の保存先 vault 相対パスを返す。
 * 空文字なら kanban 既定 `<tasksDir>/_attachments` にフォールバック。
 */
export function resolveAttachmentDir(attachmentDir: string, tasksDir: string): string {
  const trimmed = attachmentDir.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return `${tasksDir}/_attachments`;
  if (trimmed.includes("..")) return `${tasksDir}/_attachments`;
  return trimmed;
}

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
