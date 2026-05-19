import type { Plugin } from "obsidian";

export type GateMode = "normal" | "readOnly";

export interface GateResult {
  mode: GateMode;
  warnings: string[];
  errors: string[];
}

export class PluginLifecycle {
  private disposers: Array<() => void | Promise<void>> = [];

  constructor(private plugin: Plugin) {}

  async onLoad(): Promise<void> {
    const existing = this.plugin.app.workspace.getLeavesOfType("kanban-view");
    if (existing.length > 0) {
      console.log("[kanban] hot reload detected, detaching", existing.length, "leaves");
      this.plugin.app.workspace.detachLeavesOfType("kanban-view");
    }
  }

  applyGateResult(result: GateResult): void {
    if (result.warnings.length > 0) {
      console.warn("[kanban] gate warnings:", result.warnings);
    }
    if (result.errors.length > 0) {
      console.error("[kanban] gate errors -> readOnly mode:", result.errors);
    }
  }

  registerDisposer(fn: () => void | Promise<void>): void {
    this.disposers.push(fn);
  }

  async onUnload(): Promise<void> {
    const reversed = [...this.disposers].reverse();
    for (const fn of reversed) {
      try {
        await fn();
      } catch (e) {
        console.warn("[kanban] disposer error:", e);
      }
    }
    this.disposers = [];
  }
}
