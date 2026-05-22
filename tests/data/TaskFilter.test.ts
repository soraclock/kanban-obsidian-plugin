import { describe, it, expect } from "vitest";
import { filterTasks, collectAllTags, collectAssignees } from "../../src/data/TaskFilter";
import type { Task } from "../../src/data/Task";
import type { Status, Priority } from "../../src/data/TaskSchema";
import type { BoardFilter } from "../../src/store/boardStore";

function t(opts: Partial<Task> & { id: string }): Task {
  return {
    id: opts.id,
    title: opts.title ?? opts.id,
    status: (opts.status ?? "未着手") as Status,
    assignee: opts.assignee ?? "花木",
    priority: (opts.priority ?? "P2") as Priority,
    due: opts.due ?? null,
    created: "2026-05-01",
    updated: "2026-05-01",
    tags: opts.tags ?? [],
    order: opts.order,
    filePath: `tasks/${opts.id}.md`,
    contentHash: "h",
    bodyMarkdown: opts.bodyMarkdown ?? "",
    subtasks: [],
  };
}

const EMPTY: BoardFilter = {
  priorities: [],
  statuses: [],
  tags: [],
  assignees: [],
  due: null,
  searchQuery: "",
};

describe("filterTasks (Phase 6)", () => {
  it("returns all tasks when filter is empty", () => {
    const tasks = [t({ id: "a" }), t({ id: "b" })];
    expect(filterTasks(tasks, EMPTY)).toEqual(tasks);
  });

  it("filters by priority (OR)", () => {
    const tasks = [
      t({ id: "a", priority: "P0" }),
      t({ id: "b", priority: "P1" }),
      t({ id: "c", priority: "P2" }),
    ];
    const r = filterTasks(tasks, { ...EMPTY, priorities: ["P0", "P2"] });
    expect(r.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("filters by tags (AND - all selected tags must be present)", () => {
    const tasks = [
      t({ id: "a", tags: ["x", "y"] }),
      t({ id: "b", tags: ["x"] }),
      t({ id: "c", tags: ["y", "z"] }),
    ];
    const r = filterTasks(tasks, { ...EMPTY, tags: ["x", "y"] });
    expect(r.map((x) => x.id)).toEqual(["a"]);
  });

  it("search matches title substring case-insensitively", () => {
    const tasks = [
      t({ id: "a", title: "SigmaSync UI 統一" }),
      t({ id: "b", title: "アワード2026 素材" }),
    ];
    const r = filterTasks(tasks, { ...EMPTY, searchQuery: "sigma" });
    expect(r.map((x) => x.id)).toEqual(["a"]);
  });

  it("search ignores leading/trailing whitespace", () => {
    const tasks = [t({ id: "a", title: "hello world" })];
    expect(filterTasks(tasks, { ...EMPTY, searchQuery: "  hello  " }).map((x) => x.id)).toEqual(["a"]);
  });

  describe("due filter", () => {
    const today = new Date("2026-05-12T00:00:00");
    it("today", () => {
      const tasks = [
        t({ id: "a", due: "2026-05-12" }),
        t({ id: "b", due: "2026-05-13" }),
        t({ id: "c", due: null }),
      ];
      const r = filterTasks(tasks, { ...EMPTY, due: "today" }, today);
      expect(r.map((x) => x.id)).toEqual(["a"]);
    });
    it("thisWeek (today から +7 日まで)", () => {
      const tasks = [
        t({ id: "a", due: "2026-05-11" }), // 過去
        t({ id: "b", due: "2026-05-12" }), // 今日
        t({ id: "c", due: "2026-05-19" }), // +7 日
        t({ id: "d", due: "2026-05-20" }), // 範囲外
      ];
      const r = filterTasks(tasks, { ...EMPTY, due: "thisWeek" }, today);
      expect(r.map((x) => x.id)).toEqual(["b", "c"]);
    });
    it("overdue", () => {
      const tasks = [
        t({ id: "a", due: "2026-05-11" }),
        t({ id: "b", due: "2026-05-12" }),
        t({ id: "c", due: null }),
      ];
      const r = filterTasks(tasks, { ...EMPTY, due: "overdue" }, today);
      expect(r.map((x) => x.id)).toEqual(["a"]);
    });
    it("noDue", () => {
      const tasks = [t({ id: "a", due: "2026-05-12" }), t({ id: "b", due: null })];
      const r = filterTasks(tasks, { ...EMPTY, due: "noDue" }, today);
      expect(r.map((x) => x.id)).toEqual(["b"]);
    });
  });

  it("AND combines all filter dimensions", () => {
    const today = new Date("2026-05-12T00:00:00");
    const tasks = [
      t({ id: "a", priority: "P0", tags: ["x"], due: "2026-05-12", title: "SigmaSync A" }),
      t({ id: "b", priority: "P0", tags: ["x"], due: "2026-05-12", title: "Other" }),
      t({ id: "c", priority: "P1", tags: ["x"], due: "2026-05-12", title: "SigmaSync C" }),
    ];
    const r = filterTasks(
      tasks,
      { priorities: ["P0"], statuses: [], tags: ["x"], assignees: [], due: "today", searchQuery: "Sigma" },
      today,
    );
    expect(r.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("collectAllTags", () => {
  it("returns unique sorted tags", () => {
    const tasks = [
      t({ id: "a", tags: ["zebra", "alpha"] }),
      t({ id: "b", tags: ["alpha", "beta"] }),
    ];
    expect(collectAllTags(tasks)).toEqual(["alpha", "beta", "zebra"]);
  });
  it("returns empty for no tags", () => {
    expect(collectAllTags([t({ id: "a" })])).toEqual([]);
  });
});

describe("filterTasks assignees (v0.6.6)", () => {
  it("filters by assignees (OR)", () => {
    const tasks = [
      t({ id: "a", assignee: "花木" }),
      t({ id: "b", assignee: "山田" }),
      t({ id: "c", assignee: "佐藤" }),
    ];
    const r = filterTasks(tasks, { ...EMPTY, assignees: ["花木", "佐藤"] });
    expect(r.map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("empty assignees = pass all", () => {
    const tasks = [
      t({ id: "a", assignee: "花木" }),
      t({ id: "b", assignee: "" }),
    ];
    expect(filterTasks(tasks, EMPTY).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("collectAssignees (v0.6.6)", () => {
  it("places defaultAssignee at the top when it exists in tasks", () => {
    const tasks = [
      t({ id: "a", assignee: "山田" }),
      t({ id: "b", assignee: "山田" }),
      t({ id: "c", assignee: "花木" }),
    ];
    // 件数だけ見れば山田が先だが、defaultAssignee=花木 を先頭固定
    expect(collectAssignees(tasks, "花木")).toEqual(["花木", "山田"]);
  });
  it("falls back to count desc, then localeCompare when defaultAssignee is empty", () => {
    const tasks = [
      t({ id: "a", assignee: "Sato" }),
      t({ id: "b", assignee: "Sato" }),
      t({ id: "c", assignee: "Aoki" }),
      t({ id: "d", assignee: "Tanaka" }),
    ];
    // 件数: Sato=2 (先頭) / Aoki=1, Tanaka=1 (同数なので localeCompare 昇順 = A→T)
    expect(collectAssignees(tasks, "")).toEqual(["Sato", "Aoki", "Tanaka"]);
  });
  it("excludes empty string assignee from the chip list", () => {
    const tasks = [
      t({ id: "a", assignee: "" }),
      t({ id: "b", assignee: "花木" }),
    ];
    expect(collectAssignees(tasks, "花木")).toEqual(["花木"]);
  });
  it("defaultAssignee not present in tasks → not added to the head", () => {
    const tasks = [
      t({ id: "a", assignee: "山田" }),
      t({ id: "b", assignee: "佐藤" }),
    ];
    // 花木 がタスクに存在しなければ先頭に出さない（空チップを出さない）
    expect(collectAssignees(tasks, "花木")).toEqual(["佐藤", "山田"]);
  });
});
