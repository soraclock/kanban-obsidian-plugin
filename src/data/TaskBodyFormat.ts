import type { Subtask } from "./Task";

/**
 * 本文 markdown を 説明 / サブタスク / メモ の 3 セクションに分解した中間表現。
 *
 * 既存テンプレート構造:
 * ```
 * ## 背景
 * ...説明テキスト...
 *
 * ## 次のアクション
 * - [ ] サブタスク1
 * - [x] サブタスク2 (チェック済み)
 *
 * ## メモ
 * ...備考テキスト...
 * ```
 *
 * 設計方針:
 * - 既知の 3 セクション (背景 / 次のアクション / メモ) を field に分解
 * - 未知セクションは memo 末尾に `\n\n## xxx\n...` のまま保持 (data 損失なし、花木 FB a 反映)
 * - 「次のアクション」内の `- [ ]` / `- [x]` のみ subtask、それ以外の行は memo 末尾へ
 * - frontmatter 直後・最初の `## ` の前に文章があれば、それも memo の先頭に取り込む
 */
export interface ParsedBody {
  description: string;
  subtasks: Subtask[];
  memo: string;
}

const SECTION_BACKGROUND = "背景";
const SECTION_ACTIONS = "次のアクション";
const SECTION_MEMO = "メモ";

interface Section {
  /** `## ` の右側のヘッダ名。preamble (`## ` の前) の場合は null */
  header: string | null;
  /** ヘッダ行を除いた本文 (前後 trim 済み) */
  body: string;
}

function splitSections(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  const flush = (): void => {
    const body = currentBody.join("\n").trim();
    if (currentHeader === null && body === "") return;
    sections.push({ header: currentHeader, body });
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentHeader = m[1]!;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * 「次のアクション」セクションの本文から `- [ ]` / `- [x]` を subtask 配列に抽出。
 * subtask 以外の行は extras に集める (memo 末尾へ送るため)。
 */
function parseActionsSection(body: string): { subtasks: Subtask[]; extras: string } {
  const subtasks: Subtask[] = [];
  const extras: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-\s*\[\s*([ xX])\s*\]\s*(.*)$/);
    if (m) {
      subtasks.push({ text: m[2]!.trim(), checked: m[1]!.toLowerCase() === "x" });
    } else if (line.trim() !== "") {
      extras.push(line);
    }
  }
  return { subtasks, extras: extras.join("\n").trim() };
}

export function parseBody(md: string): ParsedBody {
  const sections = splitSections(md);
  let description = "";
  let subtasks: Subtask[] = [];
  const memoParts: string[] = [];
  const unknownTail: string[] = [];

  for (const sec of sections) {
    if (sec.header === null) {
      // preamble: 既存テンプレートには無いが、念のため memo の先頭に
      if (sec.body !== "") memoParts.unshift(sec.body);
      continue;
    }
    if (sec.header === SECTION_BACKGROUND) {
      // 同名複数の場合は最初を採用、以降は memo へ
      if (description === "") description = sec.body;
      else unknownTail.push(`## ${sec.header}\n${sec.body}`);
    } else if (sec.header === SECTION_ACTIONS) {
      const { subtasks: subs, extras } = parseActionsSection(sec.body);
      // 最初の "次のアクション" を採用、サブタスク以外の行は memo 末尾へ
      if (subtasks.length === 0) {
        subtasks = subs;
        if (extras !== "") unknownTail.push(extras);
      } else {
        unknownTail.push(`## ${sec.header}\n${sec.body}`);
      }
    } else if (sec.header === SECTION_MEMO) {
      if (sec.body !== "") memoParts.push(sec.body);
    } else {
      // 未知 section: 見出しごと memo 末尾へ
      unknownTail.push(`## ${sec.header}\n${sec.body}`);
    }
  }

  const memo = [...memoParts, ...unknownTail].filter((s) => s !== "").join("\n\n");
  return { description, subtasks, memo };
}

/**
 * 中間表現 → markdown 本文。テンプレートの順序 (背景 → 次のアクション → メモ) を維持。
 * 空のセクションは省略 (出力に出さない)。
 */
export function buildBody(parsed: ParsedBody): string {
  const blocks: string[] = [];
  if (parsed.description.trim() !== "") {
    blocks.push(`## ${SECTION_BACKGROUND}\n\n${parsed.description.trim()}`);
  }
  if (parsed.subtasks.length > 0) {
    const lines = parsed.subtasks
      .map((s) => `- [${s.checked ? "x" : " "}] ${s.text.trim()}`)
      .join("\n");
    blocks.push(`## ${SECTION_ACTIONS}\n${lines}`);
  }
  if (parsed.memo.trim() !== "") {
    blocks.push(`## ${SECTION_MEMO}\n\n${parsed.memo.trim()}`);
  }
  // テンプレート互換: 先頭に空行、末尾に改行
  return blocks.length === 0 ? "" : "\n" + blocks.join("\n\n") + "\n";
}

/**
 * `[[xxx]]` を剥がしてプレーンテキスト化 ("board" のような表記に戻す)。
 * `[[xxx]]` 形式でないものはそのまま返す (互換のため壊さない)。
 */
export function stripWikilink(raw: string): string {
  const m = raw.match(/^\[\[(.+)\]\]$/);
  return m ? m[1]! : raw;
}

/**
 * プレーンテキストを `[[xxx]]` で囲む。既に囲まれている / 空文字はそのまま。
 *
 * codex Minor 反映: URL (`https://...` 等のスキーム形式) や
 * Markdown インラインリンク (`[label](url)`) は `[[ ]]` で囲まない。
 * Obsidian の related に URL を混在させたい用途に備える。
 */
export function wrapWikilink(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed === "") return "";
  if (/^\[\[.+\]\]$/.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed; // URL スキーム
  if (/^\[.+\]\(.+\)$/.test(trimmed)) return trimmed; // Markdown インラインリンク
  return `[[${trimmed}]]`;
}
