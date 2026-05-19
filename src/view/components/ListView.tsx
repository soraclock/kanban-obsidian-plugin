import * as React from "react";
import { useMemo } from "react";
import { useBoardStore } from "../../store/boardStore";
import { STATUS_VALUES, type Status } from "../../data/TaskSchema";
import { filterTasks } from "../../data/TaskFilter";
import { TaskListCard } from "./TaskListCard";
import { DetailPane } from "./DetailPane";
import type { PluginContext } from "../PluginContext";

/**
 * Phase 9: 全アクティブタスクを縦 1 列のカードリストで表示。
 *
 * - active 3 status (未着手 / 進行中 / 確認待ち) のみ対象
 * - ステータスごとにセクションヘッダを出し、その下に order 昇順でカード並列
 * - FilterBar の statuses 絞り込みが有効ならセクションを間引く
 * - DnD は無し（クリックで詳細、カード上の ✓ ボタンで完了）
 */
const ACTIVE_STATUSES: readonly Status[] = STATUS_VALUES.filter(
  (s): s is Status => s !== "完了" && s !== "凍結",
);

export function ListView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const filter = useBoardStore((s) => s.filter);

  const sections = useMemo(() => {
    const filtered = filterTasks(tasks, filter);
    return ACTIVE_STATUSES.map((status) => {
      const items = filtered
        .filter((t) => t.status === status)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return { status, items };
    });
  }, [tasks, filter]);

  // ステータス絞り込みチップで選択中なら、空セクションは表示しない（無音）
  const visibleSections = sections.filter((sec) => {
    if (filter.statuses.length > 0) return filter.statuses.includes(sec.status);
    return true;
  });

  const totalShown = visibleSections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="kanban-list-layout">
      <div className="kanban-list-view">
        {totalShown === 0 ? (
          <p className="kanban-subview-empty">表示するタスクがありません。</p>
        ) : (
          visibleSections.map(({ status, items }) => (
            <section key={status} className="kanban-list-section">
              <h3 className="kanban-list-section-h3">
                <span className="kanban-list-section-label">{status}</span>
                <span className="kanban-list-section-count">{items.length}</span>
              </h3>
              {items.length === 0 ? (
                <p className="kanban-list-section-empty">該当タスクなし</p>
              ) : (
                <div className="kanban-list-cards">
                  {items.map((t) => (
                    <TaskListCard key={t.id} task={t} ctx={ctx} />
                  ))}
                </div>
              )}
            </section>
          ))
        )}
      </div>
      <DetailPane ctx={ctx} />
    </div>
  );
}
