import { z } from "zod";

export const STATUS_VALUES = ["定期", "未着手", "進行中", "確認待ち", "完了", "凍結"] as const;
export type Status = (typeof STATUS_VALUES)[number];

/**
 * DetailPane の「ステータス移動」ボタン群で利用可能な遷移先。
 * - 「定期」は別運用（定期列に常駐、完了ボタンから履歴生成）
 * - 「完了」は Card 上の「今回分を完了」ボタン経由のみ（履歴生成のため）
 * - 残りの未着手 / 進行中 / 確認待ち / 凍結 をワンタッチ移動ボタンに出す
 */
export const MOVABLE_STATUSES = ["未着手", "進行中", "確認待ち", "凍結"] as const;

export const PRIORITY_VALUES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID = /^K-\d{4}$/;

/**
 * js-yaml は unquoted な `2026-04-30` 形式の ISO 日付を **Date オブジェクト** に
 * 自動変換する（YAML 1.1 timestamp タグ互換）。Obsidian の Markdown frontmatter は
 * クォートなしで日付を書く運用が普通なので、Date でも string でも受け取れるよう
 * preprocess で正規化する。
 */
function dateToYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 任意の値を YYYY-MM-DD 文字列に正規化（できれば）。
 *
 * 受け付ける形:
 * - Date オブジェクト（YAML parser が timestamp として解釈した場合）
 * - "YYYY-MM-DD" 純粋形
 * - "YYYY-MM-DDTHH:MM:SS..." ISO 8601 形（過去バージョンの書き戻しで生成された遺物）
 *
 * 想定外の string や Date 以外の型はそのまま透過し、後段の regex で検証エラーにする。
 */
function toYmdIfDateLike(v: unknown): unknown {
  if (v instanceof Date && !isNaN(v.getTime())) return dateToYmd(v);
  if (typeof v === "string") {
    // 先頭 YYYY-MM-DD 部分を抽出（"2026-05-03T00:00:00.000Z" → "2026-05-03"）
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return v;
}

const dateString = z.preprocess(
  toYmdIfDateLike,
  z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
);

const nullableDateString = z.preprocess(
  (v) => {
    if (v === null) return null;
    return toYmdIfDateLike(v);
  },
  z.union([z.string().regex(ISO_DATE, "must be YYYY-MM-DD"), z.null()]),
);

/**
 * MVP frontmatter スキーマ。
 * v2 で `order` を追加（オプション、Phase 4 migration で補完）。
 * `parent / dependsOn / estimateHours / actualHours / boardId / completedAt` は
 * Phase 4 以降で更新ルール定義してから追加。
 */
export const TaskFrontmatterSchema = z
  .object({
    id: z.string().regex(TASK_ID, "id must match /^K-\\d{4}$/"),
    title: z.string().min(1),
    status: z.enum(STATUS_VALUES),
    assignee: z.string(),
    priority: z.enum(PRIORITY_VALUES),
    due: nullableDateString.optional(),
    model: z.union([z.enum(["opus", "sonnet", "haiku"]), z.null()]).optional(),
    created: dateString,
    updated: dateString,
    tags: z.array(z.string()),
    related: z.array(z.string()).optional(),
    // v2 追加
    order: z.number().finite().optional(),
    // Phase 4 (リッチメタ): 既存タスクには無いので全て optional + nullable。
    // 既存ファイルを書き換えず、新規タスクのみテンプレに従って入力する運用。
    completedAt: nullableDateString.optional(),
    estimateHours: z
      .union([z.number().finite().nonnegative(), z.null()])
      .optional(),
    actualHours: z
      .union([z.number().finite().nonnegative(), z.null()])
      .optional(),
    // Phase 7: 定期タスク。完了状態遷移時に次回分を自動複製する。
    // 書式: "daily" / "weekly:mon|tue|...|sun" / "monthly:1..31|lastday" / "every:Nd"
    recurrence: z.union([z.string().min(1), z.null()]).optional(),
    // v0.2.0: 定期タスクの履歴インスタンスマーカー（親の id を保持）。
    // 完了タブで「定期」バッジ表示の判定に使う。
    recurringHistoryOf: z.string().optional(),
  })
  .passthrough();
// passthrough: 未知キーは警告対象として SchemaAudit 側で扱う。スキーマレベルでは弾かない。

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
