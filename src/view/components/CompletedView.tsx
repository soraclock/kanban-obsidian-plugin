import * as React from "react";
import { useMemo } from "react";
import { Notice } from "obsidian";
import { useBoardStore } from "../../store/boardStore";
import type { Task } from "../../data/Task";
import { ConflictError } from "../../data/ContentHash";
import type { PluginContext } from "../PluginContext";
import { formatYmdForDisplay } from "../../util/dateFormat";

/**
 * Phase 8: status=完了 のタスクを月セクションで一覧する専用ビュー。
 *
 * 設計:
 * - 集計キーは completedAt → updated の順でフォールバック (Phase 4 リッチメタが
 *   未設定でも updated は必ず today に書かれているので必ず月 bucket に入る)
 * - 月の並びは新しい順、月内のタスクは日付の新しい順
 * - 各タスクに「未着手に戻す」「詳細を開く」のアクション
 * - 物理アーカイブ (`_archive/`) ではなく `tasks/` 直下に残ったままなので、
 *   月末の物理アーカイブ運用 (TaskWriter.archive) はこの画面の外
 */
interface CompletedItem {
  task: Task;
  /** 完了月 YYYY-MM */
  month: string;
  /** ソートキー (YYYY-MM-DD) */
  dateYmd: string;
}

function completionDateYmd(t: Task): string | null {
  const c = t.completedAt;
  if (typeof c === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const u = t.updated;
  if (typeof u === "string" && /^\d{4}-\d{2}-\d{2}$/.test(u)) return u;
  return null;
}

function formatYearMonthLabel(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return `${m[1]}年 ${parseInt(m[2]!, 10)}月`;
}

export function CompletedView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const requestReload = useBoardStore((s) => s.requestReload);
  const openDetail = useBoardStore((s) => s.openDetail);
  const setCurrentView = useBoardStore((s) => s.setCurrentView);
  const revertingRef = React.useRef<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const items: CompletedItem[] = [];
    for (const t of tasks) {
      if (t.status !== "完了") continue;
      const dateYmd = completionDateYmd(t);
      if (!dateYmd) continue;
      const month = dateYmd.slice(0, 7);
      items.push({ task: t, month, dateYmd });
    }
    // 日付の新しい順
    items.sort((a, b) => (a.dateYmd < b.dateYmd ? 1 : -1));
    // 月ごとに bucket、Map で挿入順を保つ
    const buckets = new Map<string, CompletedItem[]>();
    for (const it of items) {
      const arr = buckets.get(it.month);
      if (arr) arr.push(it);
      else buckets.set(it.month, [it]);
    }
    return Array.from(buckets.entries()); // [month, items[]] の配列、月新しい順
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
        before: { status: "完了" },
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
        console.error("[kanban] revert completed failed:", e);
      }
    } finally {
      revertingRef.current.delete(task.filePath);
    }
  };

  return (
    <div className="kanban-subview kanban-completed-view">
      <header className="kanban-subview-header">
        <button
          type="button"
          className="kanban-subview-back"
          onClick={() => setCurrentView("board")}
        >
          ← カンバンへ戻る
        </button>
        <h2 className="kanban-subview-h2">完了タスク</h2>
      </header>
      {grouped.length === 0 ? (
        <p className="kanban-subview-empty">完了タスクはまだありません。</p>
      ) : (
        <div className="kanban-completed-list">
          {grouped.map(([month, items]) => (
            <section key={month} className="kanban-completed-month">
              <h3 className="kanban-completed-month-h3">
                {formatYearMonthLabel(month)}
                <span className="kanban-completed-month-count">{items.length} 件</span>
              </h3>
              <div className="kanban-completed-rows">
                {items.map(({ task, dateYmd }) => (
                  <div key={task.filePath} className="kanban-completed-row">
                    <div className="kanban-completed-main">
                      <div className="kanban-completed-title">
                        <span className="kanban-completed-id">{task.id}</span>
                        <span className="kanban-completed-text">{task.title}</span>
                      </div>
                      <div className="kanban-completed-meta">
                        <span className="kanban-completed-date">{formatYmdForDisplay(dateYmd)}</span>
                        <span
                          className={`kanban-badge kanban-priority-${task.priority.toLowerCase()}`}
                        >
                          {task.priority}
                        </span>
                        {task.tags.length > 0 && (
                          <span className="kanban-completed-tags">
                            {task.tags.map((t) => (
                              <span key={t} className="kanban-tag">
                                {t}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="kanban-completed-actions">
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
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
