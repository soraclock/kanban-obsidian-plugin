import * as React from "react";
import type { App } from "obsidian";
import { Board } from "./components/Board";
import { ArchiveView } from "./components/ArchiveView";
import { CompletedView } from "./components/CompletedView";
import { FrozenView } from "./components/FrozenView";
import { ViewTabs } from "./components/ViewTabs";
import { useBoardStore } from "../store/boardStore";
import type { PluginContext } from "./PluginContext";

/**
 * Phase 8: 4 ビュー切替の常時タブバー + 選択中のビュー本体。
 * board (3 列) / completed / frozen / archive をルーティングする。
 */
export function KanbanRoot({ app, ctx }: { app: App; ctx: PluginContext }) {
  const currentView = useBoardStore((s) => s.currentView);
  return (
    <div className="kanban-root-inner">
      <ViewTabs />
      {currentView === "board" && <Board app={app} ctx={ctx} />}
      {currentView === "completed" && <CompletedView ctx={ctx} />}
      {currentView === "frozen" && <FrozenView ctx={ctx} />}
      {currentView === "archive" && <ArchiveView app={app} ctx={ctx} />}
    </div>
  );
}
