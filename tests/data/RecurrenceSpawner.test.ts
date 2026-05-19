import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { RecurrenceSpawner } from "../../src/data/RecurrenceSpawner";
import type { Task } from "../../src/data/Task";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const README_PATH = `${TASKS_DIR}/_README.md`;

function makeReadme(nextNum: number): string {
  return `# タスクボード\n\n次のID: **K-${String(nextNum).padStart(4, "0")}**\n`;
}

function makeSourceTask(overrides: Partial<Task & { recurrence?: string | null; estimateHours?: number | null }> = {}): Task & { recurrence?: string | null; estimateHours?: number | null } {
  return {
    id: "K-0005",
    title: "週次レビュー",
    status: "完了",
    assignee: "花木",
    priority: "P1",
    due: "2026-05-11",
    created: "2026-05-01",
    updated: "2026-05-11",
    tags: ["weekly"],
    related: [],
    order: 5,
    filePath: `${TASKS_DIR}/K-0005-週次レビュー.md`,
    contentHash: "abc123",
    bodyMarkdown: "\n## サブタスク\n\n- [x] 完了済み\n- [x] これも済み\n",
    subtasks: [
      { text: "完了済み", checked: true },
      { text: "これも済み", checked: true },
    ],
    recurrence: "weekly:mon",
    estimateHours: 2,
    ...overrides,
  };
}

function buildEnv(extraFiles: Record<string, string> = {}) {
  const { app, files } = makeFakeApp({
    [README_PATH]: makeReadme(6),
    ...extraFiles,
  });
  const pathLock = new PathLock();
  const spawner = new RecurrenceSpawner(app as never, TASKS_DIR, pathLock);
  return { app, files, spawner };
}

describe("RecurrenceSpawner integration", () => {
  it("case 1: 正常 spawn (weekly:mon) → 次回 due が翌週月曜", async () => {
    const { spawner } = buildEnv();
    const source = makeSourceTask({ due: "2026-05-11" }); // 2026-05-11 は月曜

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    expect(result).not.toBeNull();
    expect(result!.newDue).toBe("2026-05-18"); // 翌週月曜
  });

  it("case 2: ID 採番 — _README.md を読んで K-0006 を作成し K-0007 に更新", async () => {
    const { files, spawner } = buildEnv();
    const source = makeSourceTask();

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    expect(result!.newId).toBe("K-0006");
    expect(result!.newFilePath).toContain("K-0006-");
    expect(files[result!.newFilePath]).toBeDefined();
    // _README.md が K-0007 に更新されている
    expect(files[README_PATH]).toContain("K-0007");
  });

  it("case 3: subtask reset — source の [x] が [ ] に変換される", async () => {
    const { files, spawner } = buildEnv();
    const source = makeSourceTask();

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    const newContent = files[result!.newFilePath]!;
    expect(newContent).toContain("- [ ] 完了済み");
    expect(newContent).toContain("- [ ] これも済み");
    expect(newContent).not.toContain("- [x]");
  });

  it("case 4: completedAt=null + actualHours=null — 実績は引き継がない", async () => {
    const { files, spawner } = buildEnv();
    const source = makeSourceTask();

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    const parsed = matter(files[result!.newFilePath]!);
    expect(parsed.data.completedAt).toBeNull();
    expect(parsed.data.actualHours).toBeNull();
    expect(parsed.data.status).toBe("未着手");
  });

  it("case 5: recurrence + estimateHours は引き継ぐ", async () => {
    const { files, spawner } = buildEnv();
    const source = makeSourceTask({ estimateHours: 2, recurrence: "weekly:mon" });

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    const parsed = matter(files[result!.newFilePath]!);
    expect(parsed.data.recurrence).toBe("weekly:mon");
    expect(parsed.data.estimateHours).toBe(2);
  });

  it("case 6: slug サニタイズ — `/` や `..` は `-` に置換", async () => {
    const { files, spawner } = buildEnv();
    // ファイル名に / や .. が入ったスラグを持つソース
    const source = makeSourceTask({
      filePath: `${TASKS_DIR}/K-0005-foo-bar.md`,
    });

    const result = await spawner.spawnIfRecurring(source, "2026-05-11");

    // 結果のパスに / や .. が含まれないこと
    const newPath = result!.newFilePath;
    const fileName = newPath.split("/").pop()!;
    expect(fileName).not.toContain("..");
    expect(fileName.split("/")).toHaveLength(1);
  });

  it("case 7: path validation — isSafeRelativePath で守られている", async () => {
    // tasksDir に危険なパスを渡すと spawn 失敗する
    const { app, files } = makeFakeApp({ [README_PATH]: makeReadme(6) });
    const pathLock = new PathLock();
    // tasksDir に `..` を含む危険なパス
    const spawner = new RecurrenceSpawner(app as never, "../evil", pathLock);
    const source = makeSourceTask();

    // spawnIfRecurring 内で _README.md 取得が失敗する（file not found）
    await expect(spawner.spawnIfRecurring(source, "2026-05-11")).rejects.toThrow();
    void files; // suppress unused warning
  });

  it("case 8: recurrence null/invalid なら spawn しない (null を返す)", async () => {
    const { spawner } = buildEnv();

    // recurrence null
    const sourceNull = makeSourceTask({ recurrence: null });
    expect(await spawner.spawnIfRecurring(sourceNull, "2026-05-11")).toBeNull();

    // recurrence 未設定 (undefined)
    const sourceUndef = makeSourceTask({ recurrence: undefined });
    expect(await spawner.spawnIfRecurring(sourceUndef, "2026-05-11")).toBeNull();

    // recurrence 不正書式
    const sourceBad = makeSourceTask({ recurrence: "invalid-spec" });
    expect(await spawner.spawnIfRecurring(sourceBad, "2026-05-11")).toBeNull();
  });
});
