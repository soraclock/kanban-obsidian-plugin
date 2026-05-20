import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { RecurrenceSpawner } from "../../src/data/RecurrenceSpawner";
import type { Task } from "../../src/data/Task";
import { sha256 } from "../../src/data/ContentHash";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const README_PATH = `${TASKS_DIR}/_README.md`;

function makeReadme(nextNum: number): string {
  return `# タスクボード\n\n次のID: **K-${String(nextNum).padStart(4, "0")}**\n`;
}

function makeSourceTask(
  overrides: Partial<Task & { recurrence?: string | null; estimateHours?: number | null }> = {},
): Task & { recurrence?: string | null; estimateHours?: number | null } {
  return {
    id: "K-0005",
    title: "週次レビュー",
    status: "定期",
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

/**
 * 親ファイル (status=定期) も vault に登録した状態で fake app を作る。
 * RecurrenceSpawner.updateParentTask が parent を read/modify するため、
 * テストで実際に親ファイルが存在する必要がある。
 */
function buildEnv(extraFiles: Record<string, string> = {}) {
  const source = makeSourceTask();
  const parentContent =
    "---\nid: K-0005\ntitle: 週次レビュー\nstatus: 定期\nassignee: 花木\npriority: P1\ndue: 2026-05-11\nrecurrence: weekly:mon\ntags: [weekly]\nrelated: []\ncreated: 2026-05-01\nupdated: 2026-05-11\norder: 5\nestimateHours: 2\n---\n\n## サブタスク\n\n- [x] 完了済み\n- [x] これも済み\n";
  // 新モデル (v0.2.3) では PathLock 内で親 hash を再検証するため、テスト fixture も実 hash を渡す
  const parentHash = sha256(parentContent);
  const { app, files } = makeFakeApp({
    [README_PATH]: makeReadme(6),
    [source.filePath]: parentContent,
    ...extraFiles,
  });
  const pathLock = new PathLock();
  const spawner = new RecurrenceSpawner(app as never, TASKS_DIR, pathLock);
  return { app, files, spawner, parentHash };
}

describe("RecurrenceSpawner (新モデル: 履歴生成 + 親 due 更新)", () => {
  it("case 1: weekly:mon の親を完了 → 履歴 K-NNNN 生成 + 親の due が翌週月曜に", async () => {
    const { files, spawner, parentHash } = buildEnv();
    const source = makeSourceTask({ contentHash: parentHash, due: "2026-05-11" }); // 2026-05-11 は月曜

    const result = await spawner.completeRecurringInstance(source, "2026-05-11");

    expect(result).not.toBeNull();
    expect(result!.newDue).toBe("2026-05-18"); // 翌週月曜
    // 親ファイルの due が翌週月曜に更新されている
    const parentParsed = matter(files[source.filePath]!);
    expect(parentParsed.data.due).toBe("2026-05-18");
    // 親の status は「定期」のまま
    expect(parentParsed.data.status).toBe("定期");
  });

  it("case 2: ID 採番 — _README.md を読んで K-0006 を履歴として作成し K-0007 に更新", async () => {
    const { files, spawner, parentHash } = buildEnv();
    const source = makeSourceTask({ contentHash: parentHash });

    const result = await spawner.completeRecurringInstance(source, "2026-05-11");

    // collectExistingIds で K-0005 を発見し +1 で K-0006 を採番（衝突なし）
    expect(result!.newId).toBe("K-0006");
    expect(result!.newFilePath).toContain("K-0006-");
    expect(result!.newFilePath).toContain("2026-05-11"); // 日付サフィックス
    expect(files[result!.newFilePath]).toBeDefined();
    expect(files[README_PATH]).toContain("K-0007");
  });

  it("case 3: 履歴は status=完了 / recurrence=null / completedAt=今日", async () => {
    const { files, spawner, parentHash } = buildEnv();
    const source = makeSourceTask({ contentHash: parentHash });

    const result = await spawner.completeRecurringInstance(source, "2026-05-11");

    const parsed = matter(files[result!.newFilePath]!);
    expect(parsed.data.status).toBe("完了");
    expect(parsed.data.recurrence).toBeNull();
    expect(parsed.data.completedAt).toBe("2026-05-11");
    expect(parsed.data.recurringHistoryOf).toBe("K-0005");
  });

  it("case 4: 親の subtasks が unchecked にリセットされる", async () => {
    const { files, spawner, parentHash } = buildEnv();
    const source = makeSourceTask({ contentHash: parentHash });

    await spawner.completeRecurringInstance(source, "2026-05-11");

    const parentContent = files[source.filePath]!;
    expect(parentContent).toContain("- [ ] 完了済み");
    expect(parentContent).toContain("- [ ] これも済み");
    expect(parentContent).not.toContain("- [x]");
  });

  it("case 5: estimateHours / actualHours は履歴に引き継ぐ（その回の実績記録）", async () => {
    const { files, spawner, parentHash } = buildEnv();
    const source = makeSourceTask({
      contentHash: parentHash,
      estimateHours: 2,
    });
    (source as unknown as { actualHours?: number | null }).actualHours = 1.5;

    const result = await spawner.completeRecurringInstance(source, "2026-05-11");

    const parsed = matter(files[result!.newFilePath]!);
    expect(parsed.data.estimateHours).toBe(2);
    expect(parsed.data.actualHours).toBe(1.5);
  });

  it("case 6: slug サニタイズ — ファイル名に危険文字を含まない", async () => {
    const extraPath = `${TASKS_DIR}/K-0005-foo-bar.md`;
    const extraContent =
      "---\nid: K-0005\ntitle: 週次レビュー\nstatus: 定期\nassignee: 花木\npriority: P1\ndue: 2026-05-11\nrecurrence: weekly:mon\ntags: [weekly]\nrelated: []\ncreated: 2026-05-01\nupdated: 2026-05-11\norder: 5\nestimateHours: 2\n---\n\n## サブタスク\n\n- [x] 完了済み\n- [x] これも済み\n";
    const { app, files } = makeFakeApp({
      [README_PATH]: makeReadme(6),
      [extraPath]: extraContent,
    });
    const pathLock = new PathLock();
    const spawner = new RecurrenceSpawner(app as never, TASKS_DIR, pathLock);
    const source = makeSourceTask({
      filePath: extraPath,
      contentHash: sha256(extraContent),
    });
    void files;

    const result = await spawner.completeRecurringInstance(source, "2026-05-11");

    const fileName = result!.newFilePath.split("/").pop()!;
    expect(fileName).not.toContain("..");
    expect(fileName.split("/")).toHaveLength(1);
  });

  it("case 7: path validation — tasksDir が不正なら _README.md が見つからずエラー", async () => {
    const { app, files } = makeFakeApp({ [README_PATH]: makeReadme(6) });
    const pathLock = new PathLock();
    const spawner = new RecurrenceSpawner(app as never, "../evil", pathLock);
    const source = makeSourceTask();

    await expect(spawner.completeRecurringInstance(source, "2026-05-11")).rejects.toThrow();
    void files;
  });

  it("case 8: recurrence null/invalid なら null を返す", async () => {
    const { spawner } = buildEnv();

    const sourceNull = makeSourceTask({ recurrence: null });
    expect(await spawner.completeRecurringInstance(sourceNull, "2026-05-11")).toBeNull();

    const sourceUndef = makeSourceTask({ recurrence: undefined });
    expect(await spawner.completeRecurringInstance(sourceUndef, "2026-05-11")).toBeNull();

    const sourceBad = makeSourceTask({ recurrence: "invalid-spec" });
    expect(await spawner.completeRecurringInstance(sourceBad, "2026-05-11")).toBeNull();
  });

  it("case 9: spawnIfRecurring は status=定期 でないタスクに対しては null を返す（旧 API 互換）", async () => {
    const { spawner } = buildEnv();
    // 既存仕様変更点: 旧モデルでは status 不問だったが、新モデルでは「定期」のみ受け付ける
    const source = makeSourceTask({ status: "完了" });
    expect(await spawner.spawnIfRecurring(source, "2026-05-11")).toBeNull();
  });
});
