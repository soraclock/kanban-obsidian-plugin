import * as React from "react";
import { useBoardStore, type CurrentView } from "../../store/boardStore";

/**
 * Phase 8: 4 ビュー (ボード / 完了 / 凍結 / アーカイブ) のタブ切替バー。
 * KanbanRoot の最上部に常駐し、どのビューからでも他ビューに 1 クリックで遷移できる。
 *
 * - 完了 / 凍結タブには件数バッジを表示 (アクティブ件数で滞留を可視化)
 * - アーカイブは物理移動済 (`_archive/`) で件数が大きく増えるため、ここでは件数を出さない
 *   (ArchiveView 自身が月別件数を出す)
 */
interface TabDef {
  key: CurrentView;
  label: string;
}

const TABS: readonly TabDef[] = [
  { key: "board", label: "ボード" },
  { key: "completed", label: "完了" },
  { key: "frozen", label: "凍結" },
  { key: "archive", label: "アーカイブ" },
];

export function ViewTabs() {
  const tasks = useBoardStore((s) => s.tasks);
  const currentView = useBoardStore((s) => s.currentView);
  const setCurrentView = useBoardStore((s) => s.setCurrentView);

  const counts = React.useMemo(() => {
    let completed = 0;
    let frozen = 0;
    for (const t of tasks) {
      if (t.status === "完了") completed++;
      else if (t.status === "凍結") frozen++;
    }
    return { completed, frozen };
  }, [tasks]);

  return (
    <div className="kanban-view-tabs" role="tablist" aria-label="ビュー切替">
      {TABS.map((tab) => {
        const active = currentView === tab.key;
        const badge =
          tab.key === "completed"
            ? counts.completed
            : tab.key === "frozen"
              ? counts.frozen
              : null;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`kanban-view-tab ${active ? "is-active" : ""}`}
            onClick={() => setCurrentView(tab.key)}
          >
            <span className="kanban-view-tab-label">{tab.label}</span>
            {badge !== null && (
              <span className="kanban-view-tab-badge">{badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
