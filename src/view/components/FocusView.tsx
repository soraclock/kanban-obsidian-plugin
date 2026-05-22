import * as React from "react";
import { useMemo } from "react";
import { useBoardStore } from "../../store/boardStore";
import { STATUS_VALUES, type Status } from "../../data/TaskSchema";
import { filterTasks } from "../../data/TaskFilter";
import { TaskListCard } from "./TaskListCard";
import { DetailPane } from "./DetailPane";
import type { PluginContext } from "../PluginContext";

/**
 * Phase 9: 1 ステータスだけを大きく表示するフォーカスモード。
 *
 * - 上部に [未着手][進行中][確認待ち] のステータス切替タブ（件数バッジ付き）
 * - 選択中のステータスのタスクだけを大きく縦並べ
 * - FilterBar の statuses 絞り込みが 1 件だけ選択されている場合はそれを優先表示
 * - DnD は無し
 */
const ACTIVE_STATUSES: readonly Status[] = STATUS_VALUES.filter(
  (s): s is Status => s !== "完了" && s !== "凍結",
);

export function FocusView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const filter = useBoardStore((s) => s.filter);
  const focusedStatus = useBoardStore((s) => s.focusedStatus);
  const setFocusedStatus = useBoardStore((s) => s.setFocusedStatus);

  // フォーカスモードでは focusedStatus を単一の真とする (タブが source of truth)。
  // ただし board / list で「ステータスチップ単一選択」状態のままフォーカスへ
  // 切替えた場合の体感を保つため、チップが 1 件のときだけ focusedStatus を
  // チップ値に追従させる (チップが空 / 複数の場合は既存 focusedStatus を維持)。
  React.useEffect(() => {
    if (filter.statuses.length === 1 && filter.statuses[0] !== focusedStatus) {
      setFocusedStatus(filter.statuses[0]!);
    }
    // intentionally not depending on focusedStatus to avoid feedback loop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter.statuses, setFocusedStatus]);
  const effectiveStatus: Status = focusedStatus;

  const { itemsByStatus, totalByStatus } = useMemo(() => {
    const total: Record<string, number> = {};
    const byStatus: Record<string, ReturnType<typeof filterTasks>> = {};
    for (const s of ACTIVE_STATUSES) {
      total[s] = 0;
      byStatus[s] = [];
    }
    // 件数バッジは「絞り込み無視」で active 3 status の総数（全体感が分かるよう）
    for (const t of tasks) {
      if (Object.prototype.hasOwnProperty.call(total, t.status)) {
        total[t.status] = (total[t.status] ?? 0) + 1;
      }
    }
    // 表示は filter + 並び替えを通したもの（チップ・期限・タグ・検索すべて反映）
    const filtered = filterTasks(tasks, filter);
    for (const t of filtered) {
      if (Object.prototype.hasOwnProperty.call(byStatus, t.status)) {
        (byStatus[t.status] as unknown[]).push(t);
      }
    }
    for (const s of ACTIVE_STATUSES) {
      byStatus[s] = (byStatus[s] ?? []).sort(
        (a, b) => ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0),
      );
    }
    return { itemsByStatus: byStatus, totalByStatus: total };
  }, [tasks, filter]);

  const currentItems = itemsByStatus[effectiveStatus] ?? [];

  return (
    <div className="kanban-focus-layout">
      <div className="kanban-focus-view">
        <div className="kanban-focus-tabs" role="tablist" aria-label="フォーカス対象ステータス">
          {ACTIVE_STATUSES.map((s) => {
            const active = s === effectiveStatus;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                className={`kanban-focus-tab ${active ? "is-active" : ""}`}
                onClick={() => setFocusedStatus(s)}
              >
                <span className="kanban-focus-tab-label">{s}</span>
                <span className="kanban-focus-tab-badge">{totalByStatus[s] ?? 0}</span>
              </button>
            );
          })}
        </div>
        {currentItems.length === 0 ? (
          <p className="kanban-subview-empty">
            {effectiveStatus} のタスクはありません。
          </p>
        ) : (
          <div className="kanban-focus-cards">
            {currentItems.map((t) => (
              <TaskListCard key={t.filePath} task={t} ctx={ctx} />
            ))}
          </div>
        )}
      </div>
      <DetailPane ctx={ctx} />
    </div>
  );
}
