import { describe, it, expect } from "vitest";
import { SchemaAudit } from "../../src/data/SchemaAudit";
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

describe("SchemaAudit", () => {
  it("passes valid task with no findings", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-valid.md",
        name: "K-0001-valid.md",
        content: md({
          id: "K-0001",
          title: "valid",
          status: "未着手",
          assignee: "花木",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: ["x"],
          order: 1,
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it("detects schema invalid (bad priority)", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-bad.md",
        name: "K-0001-bad.md",
        content: md({
          id: "K-0001",
          title: "x",
          status: "未着手",
          assignee: "花木",
          priority: "P9", // invalid
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.message).toMatch(/schema invalid/);
  });

  it("detects duplicate id", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-a.md",
        name: "K-0001-a.md",
        content: md({
          id: "K-0001",
          title: "a",
          status: "未着手",
          assignee: "x",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
      {
        path: "tasks/K-0001-b.md",
        name: "K-0001-b.md",
        content: md({
          id: "K-0001",
          title: "b",
          status: "進行中",
          assignee: "x",
          priority: "P2",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.some((e) => /duplicate id/.test(e.message))).toBe(true);
  });

  it("detects filename-id mismatch", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0002-wrong.md",
        name: "K-0002-wrong.md",
        content: md({
          id: "K-0001", // filename says K-0002
          title: "x",
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
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.some((e) => /filename does not start with id/.test(e.message))).toBe(true);
  });

  it("warns on missing order", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-noorder.md",
        name: "K-0001-noorder.md",
        content: md({
          id: "K-0001",
          title: "x",
          status: "未着手",
          assignee: "x",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          // no order
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.warnings.some((w) => /order missing/.test(w.message))).toBe(true);
  });

  it("detects dependsOn reference to nonexistent id", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-dep.md",
        name: "K-0001-dep.md",
        content: md({
          id: "K-0001",
          title: "x",
          status: "未着手",
          assignee: "x",
          priority: "P1",
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
          dependsOn: ["K-9999"],
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.some((e) => /dependsOn reference "K-9999" not found/.test(e.message))).toBe(true);
  });

  it("warns on missing body action section", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-noaction.md",
        name: "K-0001-noaction.md",
        content: md(
          {
            id: "K-0001",
            title: "x",
            status: "未着手",
            assignee: "x",
            priority: "P1",
            created: "2026-05-10",
            updated: "2026-05-10",
            tags: [],
            order: 1,
          },
          "## メモ\nbody without action section\n",
        ),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.warnings.some((w) => /次のアクション.* section missing/.test(w.message))).toBe(true);
  });

  it("detects dangerous frontmatter key (__proto__)", async () => {
    // gray-matter は __proto__ を data に含めるので、生 YAML で書く
    const rawYaml = "---\n__proto__:\n  isAdmin: true\nid: K-0001\ntitle: x\nstatus: 未着手\nassignee: x\npriority: P1\ncreated: 2026-05-10\nupdated: 2026-05-10\ntags: []\norder: 1\n---\n\n## 次のアクション\n";
    const app = fakeApp([
      {
        path: "tasks/K-0001-evil.md",
        name: "K-0001-evil.md",
        content: rawYaml,
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.some((e) => /dangerous frontmatter key "__proto__"/.test(e.message))).toBe(true);
  });

  it("rejects huge file beyond size limit", async () => {
    const app = fakeApp([
      {
        path: "tasks/K-0001-huge.md",
        name: "K-0001-huge.md",
        content: "(skipped before read)",
        size: 2 * 1024 * 1024, // 2 MB > 1 MB 上限
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors.some((e) => /exceeds limit/.test(e.message))).toBe(true);
    // size 超過は read せずに skip するので、それ以外の error は無い
    expect(r.errors.length).toBe(1);
  });

  it("ignores files under _archive/", async () => {
    const app = fakeApp([
      {
        path: "tasks/_archive/2026-04/K-0001-old.md",
        name: "K-0001-old.md",
        content: md({
          id: "K-9999",
          title: "x",
          status: "未着手",
          assignee: "x",
          priority: "P9", // invalid, but archived
          created: "2026-05-10",
          updated: "2026-05-10",
          tags: [],
          order: 1,
        }),
      },
    ]);
    const audit = new SchemaAudit(app, "tasks");
    const r = await audit.run();
    expect(r.errors).toHaveLength(0);
    expect(r.scannedCount).toBe(0);
  });
});
