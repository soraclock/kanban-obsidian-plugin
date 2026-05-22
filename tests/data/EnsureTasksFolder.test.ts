import { describe, it, expect } from "vitest";
import { ensureTasksFolder, INITIAL_README } from "../../src/data/EnsureTasksFolder";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const README_PATH = `${TASKS_DIR}/_README.md`;

describe("ensureTasksFolder", () => {
  it("case 1: 何も無い vault に対してフォルダと _README.md を作る", async () => {
    const { app, files } = makeFakeApp({});

    await ensureTasksFolder(app as never, TASKS_DIR);

    expect(files[README_PATH]).toBe(INITIAL_README);
    expect(files[README_PATH]).toContain("次のID: **K-0001**");
  });

  it("case 2: 既存の _README.md があれば何も書き換えない", async () => {
    const existing = "# my readme\n\n次のID: **K-0042**\n";
    const { app, files } = makeFakeApp({ [README_PATH]: existing });

    await ensureTasksFolder(app as never, TASKS_DIR);

    expect(files[README_PATH]).toBe(existing);
  });

  it("case 3: タスクフォルダはあるが _README.md だけ無いケース（iCloud 部分同期）", async () => {
    const { app, files } = makeFakeApp({
      [`${TASKS_DIR}/K-0001-existing.md`]: "dummy",
    });

    await ensureTasksFolder(app as never, TASKS_DIR);

    expect(files[README_PATH]).toBe(INITIAL_README);
    expect(files[`${TASKS_DIR}/K-0001-existing.md`]).toBe("dummy");
  });

  it("case 4: invalid tasksDir はエラーで弾く", async () => {
    const { app } = makeFakeApp({});

    await expect(ensureTasksFolder(app as never, "")).rejects.toThrow("invalid tasksDir");
    await expect(ensureTasksFolder(app as never, "../escape")).rejects.toThrow(
      "invalid tasksDir",
    );
  });

  it("case 5: createFolder が throw しても、フォルダが結果的に存在すれば成功扱い (並列 race 想定)", async () => {
    const { app, files } = makeFakeApp({});
    let folderCreateCalls = 0;
    (app.vault as unknown as Record<string, unknown>).createFolder = async (path: string) => {
      folderCreateCalls += 1;
      // 1 回目だけ throw、その間に「他プロセスがフォルダを作った」体で fileObjs に登録
      if (folderCreateCalls === 1) {
        (app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }).getAbstractFileByPath =
          (p: string) => (p === TASKS_DIR ? { path: p } : files[p] ? { path: p } : null);
        throw new Error("folder exists (race)");
      }
    };

    // throw されても、その後 getAbstractFileByPath が folder を返せば成功
    await expect(ensureTasksFolder(app as never, TASKS_DIR)).resolves.toBeUndefined();
  });

  it("case 6: vault.create が throw + その後も file が存在しなければ throw を伝播", async () => {
    const { app } = makeFakeApp({});
    (app.vault as unknown as Record<string, unknown>).create = async () => {
      throw new Error("disk full");
    };

    await expect(ensureTasksFolder(app as never, TASKS_DIR)).rejects.toThrow("disk full");
  });

  it("case 7: 連続で複数回呼ばれても、既存ファイルは保持される (idempotent)", async () => {
    const { app, files } = makeFakeApp({});

    await ensureTasksFolder(app as never, TASKS_DIR);
    const after1st = files[README_PATH];
    await ensureTasksFolder(app as never, TASKS_DIR);
    await ensureTasksFolder(app as never, TASKS_DIR);

    expect(files[README_PATH]).toBe(after1st);
  });
});
