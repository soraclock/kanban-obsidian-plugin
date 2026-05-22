import { ItemView, WorkspaceLeaf } from "obsidian";
import * as React from "react";
import { createRoot, Root } from "react-dom/client";
import { KanbanRoot } from "./KanbanRoot";
import { useBoardStore } from "../store/boardStore";
import type { PluginContext } from "./PluginContext";

export const KANBAN_VIEW_TYPE = "kanban-view";

export class KanbanView extends ItemView {
  private root: Root | null = null;
  // 開いた時の sidebar 開閉状態を保持し、閉じる時に復元 (花木 FB「Obsidian UI と被る」対応)
  private prevLeftCollapsed: boolean | null = null;
  private prevRightCollapsed: boolean | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly ctx: PluginContext,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return KANBAN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Kanban";
  }

  getIcon(): string {
    return "kanban";
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("kanban-root");
    this.root = createRoot(this.containerEl);
    this.root.render(<KanbanRoot app={this.app} ctx={this.ctx} />);

    // 花木 FB 反映: sidebar collapse は workspace layout-changed → metadata cache rebuild
    // → 全タスク vault.modify 発火 → DetailPane で全件 conflict 化、の race を疑い一旦撤回。
    // 視認性問題は CSS (DetailPane の z-index / box-shadow / sticky footer) で対処する方針に変更。
  }

  async onClose(): Promise<void> {
    // close 時にセッション状態を全リセット (review code-reviewer#Major 反映)
    useBoardStore.getState().resetSessionState();

    // 開く前に展開されていた sidebar を復元
    try {
      const ws = this.app.workspace as unknown as {
        leftSplit?: { collapsed: boolean; collapse: () => void; expand: () => void };
        rightSplit?: { collapsed: boolean; collapse: () => void; expand: () => void };
      };
      if (ws.leftSplit && this.prevLeftCollapsed === false && ws.leftSplit.collapsed) {
        ws.leftSplit.expand();
      }
      if (ws.rightSplit && this.prevRightCollapsed === false && ws.rightSplit.collapsed) {
        ws.rightSplit.expand();
      }
    } catch (e) {
      console.warn("[kanban] sidebar restore failed:", e);
    }

    this.root?.unmount();
    this.root = null;
    this.containerEl.removeClass("kanban-root");
    this.containerEl.empty();
  }
}
