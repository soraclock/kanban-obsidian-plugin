import { describe, it, expect } from "vitest";
import { planRecompactOrders } from "../../src/data/OrderCompaction";
import type { Task } from "../../src/data/Task";
import type { Status, Priority } from "../../src/data/TaskSchema";

function t(opts: { id: string; status?: Status; order?: number; hash?: string }): Task {
  return {
    id: opts.id,
    title: opts.id,
    status: (opts.status ?? "未着手") as Status,
    assignee: "x",
    priority: "P2" as Priority,
    created: "2026-05-01",
    updated: "2026-05-01",
    tags: [],
    order: opts.order,
    filePath: `tasks/${opts.id}.md`,
    contentHash: opts.hash ?? `h-${opts.id}`,
    bodyMarkdown: "",
    subtasks: [],
  };
}

describe("planRecompactOrders (Phase 6)", () => {
  it("renumbers a single column to 1, 2, 3...", () => {
    const tasks = [
      t({ id: "a", order: 0.001 }),
      t({ id: "b", order: 0.002 }),
      t({ id: "c", order: 0.003 }),
    ];
    const plan = planRecompactOrders(tasks);
    expect(plan).toEqual([
      {
        filePath: "tasks/a.md",
        expectedHash: "h-a",
        oldOrder: 0.001,
        newOrder: 1,
        status: "未着手",
      },
      {
        filePath: "tasks/b.md",
        expectedHash: "h-b",
        oldOrder: 0.002,
        newOrder: 2,
        status: "未着手",
      },
      {
        filePath: "tasks/c.md",
        expectedHash: "h-c",
        oldOrder: 0.003,
        newOrder: 3,
        status: "未着手",
      },
    ]);
  });

  it("skips tasks whose order is already canonical", () => {
    const tasks = [t({ id: "a", order: 1 }), t({ id: "b", order: 2 }), t({ id: "c", order: 3 })];
    const plan = planRecompactOrders(tasks);
    expect(plan).toEqual([]);
  });

  it("renumbers per-column independently", () => {
    const tasks = [
      t({ id: "a1", status: "未着手", order: 1.5 }),
      t({ id: "a2", status: "未着手", order: 1.7 }),
      t({ id: "b1", status: "進行中", order: 0.5 }),
    ];
    const plan = planRecompactOrders(tasks);
    expect(plan.map((p) => [p.status, p.filePath, p.newOrder])).toEqual([
      ["未着手", "tasks/a1.md", 1],
      ["未着手", "tasks/a2.md", 2],
      ["進行中", "tasks/b1.md", 1],
    ]);
  });

  it("handles tasks without order (treated as 0)", () => {
    const tasks = [
      t({ id: "a" }), // order undefined
      t({ id: "b", order: 5 }),
    ];
    const plan = planRecompactOrders(tasks);
    // a (undef → 0) は newOrder=1、b は newOrder=2 になる
    expect(plan.map((p) => [p.filePath, p.oldOrder, p.newOrder])).toEqual([
      ["tasks/a.md", undefined, 1],
      ["tasks/b.md", 5, 2],
    ]);
  });

  it("empty input returns empty plan", () => {
    expect(planRecompactOrders([])).toEqual([]);
  });
});
