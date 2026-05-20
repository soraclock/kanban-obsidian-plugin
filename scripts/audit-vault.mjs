// corp の秘書/tasks ディレクトリの全 K-*.md を TaskFrontmatterSchema で検証する
// Usage: node scripts/audit-vault.mjs <tasks-dir>
// 出力: エラー一覧 (ファイルパス + zod issue)
//
// Frontmatter.ts と同じ Date 正規化を適用、TaskSchema.ts と同じ z スキーマを再現。

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";

const tasksDir = process.argv[2];
if (!tasksDir) {
  console.error("Usage: node scripts/audit-vault.mjs <tasks-dir>");
  process.exit(1);
}

// --- TaskSchema.ts と同じ定義（z 部分のみ）---
const STATUS_VALUES = ["定期", "未着手", "進行中", "確認待ち", "完了", "凍結"];
const PRIORITY_VALUES = ["P0", "P1", "P2", "P3"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_ID = /^K-\d{4}$/;

function dateToYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function toYmdIfDateLike(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return dateToYmd(v);
  if (typeof v === "string") {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return v;
}
const dateString = z.preprocess(toYmdIfDateLike, z.string().regex(ISO_DATE, "must be YYYY-MM-DD"));
const nullableDateString = z.preprocess(
  (v) => (v === null ? null : toYmdIfDateLike(v)),
  z.union([z.string().regex(ISO_DATE, "must be YYYY-MM-DD"), z.null()]),
);
const TaskFrontmatterSchema = z
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
    order: z.number().finite().optional(),
    completedAt: nullableDateString.optional(),
    estimateHours: z.union([z.number().finite().nonnegative(), z.null()]).optional(),
    actualHours: z.union([z.number().finite().nonnegative(), z.null()]).optional(),
    recurrence: z.union([z.string().min(1), z.null()]).optional(),
    recurringHistoryOf: z.string().optional(),
  })
  .passthrough();

// --- Frontmatter.ts と同じ Date 正規化 ---
function normalizeDateValues(data) {
  if (data === null || data === undefined) return data;
  if (data instanceof Date) {
    if (Number.isNaN(data.getTime())) return data;
    return dateToYmd(data);
  }
  if (Array.isArray(data)) return data.map(normalizeDateValues);
  if (typeof data === "object") {
    const result = {};
    for (const k of Object.keys(data)) {
      result[k] = normalizeDateValues(data[k]);
    }
    return result;
  }
  return data;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function walkK(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_archive") continue;
      out.push(...walkK(fp));
    } else if (entry.isFile() && entry.name.startsWith("K-") && entry.name.endsWith(".md")) {
      out.push(fp);
    }
  }
  return out;
}

const files = walkK(tasksDir);
const results = [];

for (const fp of files) {
  const content = fs.readFileSync(fp, "utf-8");
  const m = FRONTMATTER_RE.exec(content);
  if (!m) {
    results.push({ file: fp, error: "no frontmatter" });
    continue;
  }
  let raw;
  try {
    raw = yaml.load(m[1]);
  } catch (e) {
    results.push({ file: fp, error: `yaml parse failed: ${e.message}` });
    continue;
  }
  const normalized = normalizeDateValues(raw ?? {});
  const parsed = TaskFrontmatterSchema.safeParse(normalized);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    results.push({ file: fp, error: `schema invalid: ${msg}` });
  }
}

console.log(`Scanned: ${files.length} files`);
console.log(`Errors:  ${results.length}`);
console.log("");
for (const r of results) {
  console.log(`[FAIL] ${path.basename(r.file)}`);
  console.log(`       ${r.error}`);
  console.log("");
}
if (results.length === 0) {
  console.log("OK: no schema audit errors");
}
