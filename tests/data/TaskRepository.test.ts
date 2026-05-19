import { describe, it, expect } from "vitest";
import { TaskRepository } from "../../src/data/TaskRepository";
import type { App, TFile } from "obsidian";

interface FakeFile {
  path: string;
  name: string;
  content: string;
  size?: number;
}

function fakeApp(files: FakeFile[]): App {
  const tfiles: TFile[] = files.map((f) => ({
    path: f.path,
    name: f.name,
    basename: f.name.replace(/\.md$/, ""),
    extension: "md",
    stat: { size: f.size ?? f.content.length },
  })) as unknown as TFile[];

  return {
    vault: {
      getMarkdownFiles: () => tfiles,
      read: async (file: TFile) => {
        const found = files.find((f) => f.path === file.path);
        if (!found) throw new Error("not found: " + file.path);
        return found.content;
      },
    },
  } as unknown as App;
}

function md(fm: Record<string, unknown>, body = "## 次のアクション\n- [ ] do something\n"): string {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}

describe("TaskRepository", () => {
  it("lists valid tasks under tasksDir", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-a.md",
        name: "K-0001-a.md",
        content: md({
          id: "K-0001",
          title: "task a",
          status: "未着手",
          assignee: "花木",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: ["tag1"],
          order: 1,
        }),
      },
      {
        path: "tasks/K-0002-b.md",
        name: "K-0002-b.md",
        content: md({
          id: "K-0002",
          title: "task b",
          status: "進行中",
          assignee: "花木",
          priority: "P0",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 2,
        }),
      },
    ]);
    const repo = new TaskRepository(app, "tasks");
    const { tasks, errors } = await repo.listAll();
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe("task a");
    expect(tasks[0]!.subtasks).toEqual([{ text: "do something", checked: false }]);
    expect(tasks[0]!.filePath).toBe("tasks/K-0001-a.md");
  });

  it("excludes _archive/", async () => {
    const app = fakeApp([
      {
        path: "tasks/_archive/2026-04/K-0001-old.md",
        name: "K-0001-old.md",
        content: md({
          id: "K-0001",
          title: "archived",
          status: "完了",
          assignee: "花木",
          priority: "P3",
          created: "2026-04-01",
          updated: "2026-04-30",
          tags: [],
          order: 1,
        }),
      },
      {
        path: "tasks/K-0002-current.md",
        name: "K-0002-current.md",
        content: md({
          id: "K-0002",
          title: "current",
          status: "未着手",
          assignee: "花木",
          priority: "P2",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const repo = new TaskRepository(app, "tasks");
    const { tasks } = await repo.listAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("current");
  });

  it("rejects file exceeding size limit (review security#Major)", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-huge.md",
        name: "K-0001-huge.md",
        content: "(should not be read)",
        size: 2 * 1024 * 1024, // 2 MB > 1 MB
      },
      {
        path: "tasks/K-0002-ok.md",
        name: "K-0002-ok.md",
        content: md({
          id: "K-0002",
          title: "ok",
          status: "未着手",
          assignee: "x",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const repo = new TaskRepository(app, "tasks");
    const { tasks, errors } = await repo.listAll();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("K-0002");
    expect(errors.some((e) => /exceeds limit/.test(e.message))).toBe(true);
  });

  it("rejects dangerous frontmatter key (review security#Major)", async () => {
    const rawYaml =
      "---\n__proto__:\n  isAdmin: true\nid: K-0001\ntitle: evil\nstatus: 未着手\nassignee: x\npriority: P1\ncreated: 2026-05-10\nupdated: 2026-05-10\ntags: []\norder: 1\n---\n\n## 次のアクション\n";
    const app = fakeApp([
      {
        path: "tasks/K-0001-evil.md",
        name: "K-0001-evil.md",
        content: rawYaml,
      },
    ]);
    const repo = new TaskRepository(app, "tasks");
    const { tasks, errors } = await repo.listAll();
    expect(tasks).toHaveLength(0);
    expect(errors.some((e) => /dangerous frontmatter key "__proto__"/.test(e.message))).toBe(true);
  });

  it("collects errors for invalid schema but continues", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-bad.md",
        name: "K-0001-bad.md",
        content: md({
          id: "K-0001",
          title: "bad",
          status: "未着手",
          assignee: "x",
          priority: "P9",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
      {
        path: "tasks/K-0002-good.md",
        name: "K-0002-good.md",
        content: md({
          id: "K-0002",
          title: "good",
          status: "未着手",
          assignee: "x",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const repo = new TaskRepository(app, "tasks");
    const { tasks, errors } = await repo.listAll();
    expect(tasks).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.filePath).toBe("tasks/K-0001-bad.md");
  });
});
