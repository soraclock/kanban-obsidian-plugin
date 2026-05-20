import * as React from "react";
import type { App } from "obsidian";
import { Board } from "./components/Board";
import { CompletedView } from "./components/CompletedView";
import { FrozenView } from "./components/FrozenView";
import { ViewTabs } from "./components/ViewTabs";
import { useBoardStore } from "../store/boardStore";
import type { PluginContext } from "./PluginContext";

/**
 * 3 ビュー切替の常時タブバー + 選択中のビュー本体。
 * board (3 列) / completed / frozen をルーティングする。
 */
export function KanbanRoot({ app, ctx }: { app: App; ctx: PluginContext }) {
  const currentView = useBoardStore((s) => s.currentView);
  return (
    <div className="kanban-root-inner">
      <ViewTabs />
      {currentView === "board" && <Board app={app} ctx={ctx} />}
      {currentView === "completed" && <CompletedView ctx={ctx} />}
      {currentView === "frozen" && <FrozenView ctx={ctx} />}
    </div>
  );
}
