import { z } from "zod";

export const STATUS_VALUES = ["未着手", "進行中", "確認待ち", "完了", "凍結"] as const;
export type Status = (typeof STATUS_VALUES)[number];

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

const dateString = z.preprocess(
  (v) => (v instanceof Date && !isNaN(v.getTime()) ? dateToYmd(v) : v),
  z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
);

const nullableDateString = z.preprocess(
  (v) => {
    if (v === null) return null;
    if (v instanceof Date && !isNaN(v.getTime())) return dateToYmd(v);
    return v;
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
  })
  .passthrough();
// passthrough: 未知キーは警告対象として SchemaAudit 側で扱う。スキーマレベルでは弾かない。

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
