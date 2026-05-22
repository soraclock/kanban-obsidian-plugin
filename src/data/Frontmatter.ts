import { parseYaml, stringifyYaml } from "obsidian";

/**
 * Markdown + YAML frontmatter のパース / 生成。
 *
 * gray-matter を置き換える軽量実装。理由:
 * - gray-matter は `require("fs")` をトップレベルで実行するため、Obsidian モバイル
 *   （iOS / Android）で onload 時にクラッシュする
 * - 本プラグインは frontmatter parse + body 分離しか使わないので、Obsidian の
 *   `parseYaml` / `stringifyYaml` で十分
 */

export interface FrontmatterFile<T = Record<string, unknown>> {
  data: T;
  content: string;
  /** YAML パース失敗時にセットされる。data は空オブジェクト、content は body 部分 (review #11) */
  parseError?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Markdown 文字列を frontmatter 部分と body に分離してパース。
 *
 * frontmatter が無い / パース失敗時:
 * - data は空オブジェクト
 * - content は元の入力 or frontmatter 後の本文
 *
 * gray-matter との差分:
 * - excerpt / engines / cache 等の機能はサポートしない（本プラグインで使ってない）
 * - `originalContent` / `matter` / `language` 等のメタフィールドも持たない
 */
export function parseFile<T = Record<string, unknown>>(input: string): FrontmatterFile<T> {
  const m = FRONTMATTER_RE.exec(input);
  if (!m) {
    return { data: {} as T, content: input };
  }
  try {
    const raw = parseYaml(m[1]) ?? {};
    const data = normalizeDateValues(raw) as T;
    return { data, content: m[2] ?? "" };
  } catch (e) {
    return {
      data: {} as T,
      content: m[2] ?? "",
      parseError: `yaml_parse_error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * parseYaml は YAML の `2026-05-12` のような date リテラルを Date オブジェクトに
 * 変換する（js-yaml DEFAULT_SCHEMA の timestamp type）。gray-matter 時代は string
 * のまま残っていたため、Task の Zod schema は string (YYYY-MM-DD) を期待している。
 * このギャップを埋めるため、Date を YYYY-MM-DD 形式の string に戻す。
 *
 * UTC getter を使うのは、js-yaml が date-only literal を `Date.UTC(...)` で生成するため。
 * ローカル getter を使うと TZ ずれで日付が前日になる可能性がある。
 */
function normalizeDateValues(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (data instanceof Date) {
    if (Number.isNaN(data.getTime())) return data;
    const y = data.getUTCFullYear();
    const m = String(data.getUTCMonth() + 1).padStart(2, "0");
    const d = String(data.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (Array.isArray(data)) return data.map(normalizeDateValues);
  if (typeof data === "object") {
    // prototype pollution 対策: 通常の object literal だと `__proto__` キーの代入が
    // 特別扱いされて prototype が書き換わり、その後 Object.keys で `__proto__` が
    // 見えなくなる。`Object.create(null)` を使うと `__proto__` も普通の own property
    // として保持されるため、危険キー検出（DANGEROUS_FRONTMATTER_KEYS）が引き続き機能する。
    const result = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(data as Record<string, unknown>)) {
      result[k] = normalizeDateValues((data as Record<string, unknown>)[k]);
    }
    return result;
  }
  return data;
}

/**
 * body と data から frontmatter 付き Markdown を生成。
 *
 * gray-matter の `matter.stringify(body, data)` と同等のシグネチャ。
 * 末尾の改行は body に従う（body 末尾が改行なしなら無し）。
 */
export function stringifyFile<T extends object>(content: string, data: T): string {
  const yaml = stringifyYaml(data).replace(/\n+$/, "");
  return `---\n${yaml}\n---\n${content}`;
}
