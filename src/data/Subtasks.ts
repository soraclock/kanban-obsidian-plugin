import type { Subtask } from "./Task";

const SUBTASK_RE = /^\s*[-*+] \[(.)\]\s+(.+?)\s*$/;

/**
 * 本文の `## 次のアクション` セクション配下の checkbox を解析する。
 * 他のセクションは無視。次の `## 見出し` または EOF までを範囲とする。
 */
export function parseSubtasks(body: string, heading = "## 次のアクション"): Subtask[] {
  const section = extractSection(body, heading);
  if (section === null) return [];

  const result: Subtask[] = [];
  for (const line of section.split("\n")) {
    const m = SUBTASK_RE.exec(line);
    if (!m) continue;
    const mark = m[1]!;
    const text = m[2]!;
    result.push({
      text,
      checked: mark.toLowerCase() === "x",
    });
  }
  return result;
}

function extractSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  let inside = false;
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!inside) {
      if (trimmed === heading) {
        inside = true;
      }
      continue;
    }
    // 次の h2 でセクション終了
    if (trimmed.startsWith("## ")) break;
    collected.push(line);
  }
  return inside ? collected.join("\n") : null;
}

export function completionRate(subtasks: Subtask[]): { done: number; total: number } {
  return {
    done: subtasks.filter((s) => s.checked).length,
    total: subtasks.length,
  };
}
