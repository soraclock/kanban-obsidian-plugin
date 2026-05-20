import * as React from "react";
import { useMemo } from "react";
import { Notice } from "obsidian";
import { useBoardStore } from "../../store/boardStore";
import type { Task } from "../../data/Task";
import { ConflictError } from "../../data/ContentHash";
import type { PluginContext } from "../PluginContext";
import { formatYmdForDisplay } from "../../util/dateFormat";

/**
 * Phase 8: status=凍結 のタスク一覧。
 *
 * 凍結は再開待ち状態なので「凍結理由」「解凍条件」を見せたい。フロントマター専用フィールドは
 * テンプレに無いため、本文 (bodyMarkdown) から `## 凍結理由` / `## 解凍条件` セクションを
 * 検出して抜き出す。無ければ本文先頭 200 字を preview として出す。
 *
 * 月セクションは切らない (凍結は時間で並び替えても意味が薄い)。priority 降順 → updated 新しい順。
 */
function extractFrozenContext(body: string): { reason?: string; condition?: string; preview?: string } {
  // Markdown を行ベースで走査して見出しでセクションを切り出す
  const lines = body.split(/\r?\n/);
  const sections = new Map<string, string[]>();
  let currentKey: string | null = null;
  for (const ln of lines) {
    const m = ln.match(/^##\s*(.+?)\s*$/);
    if (m) {
      const heading = m[1]!.trim();
      // 凍結理由 / 解凍条件 を別キーで保持。それ以外の見出しは _other に流す。
      if (heading.includes("凍結理由") || heading === "理由") currentKey = "reason";
      else if (heading.includes("解凍条件") || heading === "条件") currentKey = "condition";
      else currentKey = null;
      continue;
    }
    if (currentKey === null) continue;
    const arr = sections.get(currentKey) ?? [];
    arr.push(ln);
    sections.set(currentKey, arr);
  }
  const trim = (xs: string[] | undefined): string | undefined => {
    if (!xs) return undefined;
    const joined = xs.join("\n").trim();
    return joined === "" ? undefined : joined;
  };
  const reason = trim(sections.get("reason"));
  const condition = trim(sections.get("condition"));
  if (reason || condition) return { reason, condition };
  // フォールバック: 本文先頭の非見出し行を 200 字までプレビュー
  const previewRaw = lines
    .filter((l) => !/^#+\s/.test(l))
    .join("\n")
    .trim();
  if (previewRaw === "") return {};
  return { preview: previewRaw.length > 200 ? previewRaw.slice(0, 200) + "…" : previewRaw };
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export function FrozenView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const requestReload = useBoardStore((s) => s.requestReload);
  const openDetail = useBoardStore((s) => s.openDetail);
  const setCurrentView = useBoardStore((s) => s.setCurrentView);
  const revertingRef = React.useRef<Set<string>>(new Set());

  const frozen = useMemo(() => {
    const items = tasks
      .filter((t) => t.status === "凍結")
      .map((task) => ({ task, ctx: extractFrozenContext(task.bodyMarkdown) }));
    items.sort((a, b) => {
      const pa = PRIORITY_RANK[a.task.priority] ?? 99;
      const pb = PRIORITY_RANK[b.task.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      // updated 新しい順
      return (a.task.updated < b.task.updated ? 1 : -1);
    });
    return items;
  }, [tasks]);

  const onRevert = async (task: Task): Promise<void> => {
    if (revertingRef.current.has(task.filePath)) return;
    revertingRef.current.add(task.filePath);
    try {
      const result = await ctx.taskWriter.updateStatus(
        task.filePath,
        task.contentHash,
        "未着手",
      );
      ctx.history.push({
        type: "status",
        filePath: task.filePath,
        before: { status: "凍結" },
        after: { status: "未着手" },
        afterHash: result.newHash,
        ts: new Date().toISOString(),
      });
      new Notice(`未着手に戻しました: ${task.id}`);
      requestReload();
    } catch (e) {
      if (e instanceof ConflictError) {
        new Notice("ファイルが他で変更されました。リロードします。");
        requestReload();
      } else {
        const safeMsg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`未着手に戻せませんでした: ${safeMsg}`);
        console.error("[kanban] revert frozen failed:", e);
      }
    } finally {
      revertingRef.current.delete(task.filePath);
    }
  };

  return (
    <div className="kanban-subview kanban-frozen-view">
      <header className="kanban-subview-header">
        <button
          type="button"
          className="kanban-subview-back"
          onClick={() => setCurrentView("board")}
        >
          ← カンバンへ戻る
        </button>
        <h2 className="kanban-subview-h2">凍結タスク</h2>
      </header>
      {frozen.length === 0 ? (
        <p className="kanban-subview-empty">凍結中のタスクはありません。</p>
      ) : (
        <div className="kanban-frozen-list">
          {frozen.map(({ task, ctx: context }) => (
            <article key={task.filePath} className="kanban-frozen-row">
              <header className="kanban-frozen-row-header">
                <span className="kanban-completed-id">{task.id}</span>
                <span className="kanban-frozen-title">{task.title}</span>
                <span
                  className={`kanban-badge kanban-priority-${task.priority.toLowerCase()}`}
                >
                  {task.priority}
                </span>
                <span className="kanban-frozen-updated">更新 {formatYmdForDisplay(task.updated)}</span>
              </header>
              {context.reason && (
                <div className="kanban-frozen-section">
                  <span className="kanban-frozen-label">凍結理由</span>
                  <pre className="kanban-frozen-body">{context.reason}</pre>
                </div>
              )}
              {context.condition && (
                <div className="kanban-frozen-section">
                  <span className="kanban-frozen-label">解凍条件</span>
                  <pre className="kanban-frozen-body">{context.condition}</pre>
                </div>
              )}
              {!context.reason && !context.condition && context.preview && (
                <div className="kanban-frozen-section">
                  <span className="kanban-frozen-label">メモ抜粋</span>
                  <pre className="kanban-frozen-body">{context.preview}</pre>
                </div>
              )}
              <div className="kanban-frozen-actions">
                <button
                  type="button"
                  className="kanban-subview-action"
                  onClick={() => {
                    setCurrentView("board");
                    openDetail(task.filePath);
                  }}
                >
                  詳細
                </button>
                <button
                  type="button"
                  className="kanban-subview-action"
                  onClick={() => {
                    void onRevert(task);
                  }}
                >
                  未着手に戻す
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
