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
    const data = (parseYaml(m[1]) ?? {}) as T;
    return { data, content: m[2] ?? "" };
  } catch {
    return { data: {} as T, content: m[2] ?? "" };
  }
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
