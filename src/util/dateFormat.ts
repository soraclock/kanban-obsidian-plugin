/**
 * Phase 11: 日付の表示形式統一。
 *
 * 内部データ (frontmatter / Zod schema / 比較ロジック) は YYYY-MM-DD のまま維持し、
 * UI 表示・入力フォームだけ YYYY/MM/DD を使う。
 *
 * - formatYmdForDisplay: 内部値 "2026-05-19" → 表示値 "2026/05/19"
 * - parseYmdInput: ユーザー入力 "2026/05/19" or "2026-05-19" or "2026/5/19" → 内部値 "2026-05-19"
 * - YMD_INPUT_REGEX: 入力バリデーション用 (どちらの区切りでも OK)
 */
const YMD_INTERNAL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YMD_INPUT_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/;

export const YMD_INPUT_REGEX = YMD_INPUT_RE;

export function formatYmdForDisplay(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const m = ymd.match(YMD_INTERNAL_RE);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  // 既にスラッシュ形式の場合は素通し、それ以外も握りつぶさない
  return ymd;
}

/**
 * ユーザー入力を内部値 YYYY-MM-DD に正規化。
 * - 受け入れ: "2026/05/19" "2026-05-19" "2026/5/19"
 * - 拒否（null 返却）: 空文字（trim 後）、フォーマット不一致、日付として無効（うるう年など軽い検証は省略、Zod 側に任せる）
 */
export function parseYmdInput(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(YMD_INPUT_RE);
  if (!m) return null;
  const y = m[1]!;
  const mo = m[2]!.padStart(2, "0");
  const d = m[3]!.padStart(2, "0");
  return `${y}-${mo}-${d}`;
}
