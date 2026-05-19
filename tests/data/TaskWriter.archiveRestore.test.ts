import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { WriteJournal } from "../../src/data/WriteJournal";
import { TaskWriter } from "../../src/data/TaskWriter";
import { sha256 } from "../../src/data/ContentHash";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const JOURNAL_PATH = `${TASKS_DIR}/.kanban-journal.jsonl`;

function makeContent(title = "テストタスク"): string {
  return matter.stringify("\n本文\n", {
    id: "K-0001",
    title,
    status: "完了",
    assignee: "花木",
    priority: "P1",
    created: "2026-05-11",
    updated: "2026-05-11",
    tags: [],
    order: 1,
  });
}

function buildEnv(extraFiles: Record<string, string> = {}) {
  const filePath = `${TASKS_DIR}/K-0001-test.md`;
  const content = makeContent();
  const { app, files } = makeFakeApp({ [filePath]: content, ...extraFiles });
  const pathLock = new PathLock();
  const journal = new WriteJournal(app.vault as never, JOURNAL_PATH, pathLock);
  const writer = new TaskWriter(app as never, pathLock, journal);
  return { app, files, writer, journal, filePath, content };
}

describe("TaskWriter.archive + restore integration", () => {
  it("case 1: archive で _archive/YYYY-MM/ 配置", async () => {
    const { files, writer, filePath, content } = buildEnv();
    const hash = sha256(content);

    const { archivePath } = await writer.archive(filePath, TASKS_DIR, hash);

    const now = new Date();
    const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(archivePath).toContain(`_archive/${yyyymm}/`);
    expect(archivePath).toContain("K-0001-test.md");
    expect(files[archivePath]).toBeDefined();
    // 元パスは削除済み
    expect(files[filePath]).toBeUndefined();
  });

  it("case 2: 同名衝突時は timestamp suffix が付く", async () => {
    const filePath = `${TASKS_DIR}/K-0001-test.md`;
    const content = makeContent();
    const now = new Date();
    const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    // 既にアーカイブに同名ファイルが存在する状態を作る
    const existingArchivePath = `${TASKS_DIR}/_archive/${yyyymm}/K-0001-test.md`;
    const { files, writer } = buildEnv({ [existingArchivePath]: "already archived" });
    const hash = sha256(content);

    const { archivePath } = await writer.archive(filePath, TASKS_DIR, hash);

    // 衝突回避のため suffix が付く
    expect(archivePath).not.toBe(existingArchivePath);
    expect(archivePath).toContain(`_archive/${yyyymm}/K-0001-test`);
    // suffix 付きが作成されている
    expect(files[archivePath]).toBeDefined();
    // 既存は上書きされていない
    expect(files[existingArchivePath]).toBe("already archived");
  });

  it("case 3: archive → restore で元の場所に戻る", async () => {
    const { files, writer, filePath, content } = buildEnv();
    const hash = sha256(content);

    const { archivePath } = await writer.archive(filePath, TASKS_DIR, hash);
    expect(files[filePath]).toBeUndefined();

    const { restoredPath } = await writer.restore(archivePath, TASKS_DIR);

    // tasks/ 直下に戻る
    expect(restoredPath).toBe(`${TASKS_DIR}/K-0001-test.md`);
    expect(files[restoredPath]).toBeDefined();
    // アーカイブパスは削除済み
    expect(files[archivePath]).toBeUndefined();
    // 内容は変わらない
    expect(files[restoredPath]).toBe(content);
  });

  it("case 4: restore: 元 path に同名既存なら -restored-{ts}.md suffix", async () => {
    const { files, writer, filePath, content } = buildEnv();
    const hash = sha256(content);

    const { archivePath } = await writer.archive(filePath, TASKS_DIR, hash);
    // tasks/ に同名のファイルを事前に置く
    files[filePath] = "already exists at original path";

    const { restoredPath } = await writer.restore(archivePath, TASKS_DIR);

    // suffix 付きで復元
    expect(restoredPath).not.toBe(filePath);
    expect(restoredPath).toContain("K-0001-test");
    expect(restoredPath).toContain("-restored-");
    expect(files[restoredPath]).toBe(content);
    // 既存は上書きされていない
    expect(files[filePath]).toBe("already exists at original path");
  });

  it("case 5: restore: _archive/ 外を渡すと throw", async () => {
    const { writer } = buildEnv();
    // _archive/ を含まないパス
    const outsidePath = `${TASKS_DIR}/K-0001-not-archived.md`;
    await expect(writer.restore(outsidePath, TASKS_DIR)).rejects.toThrow(/_archive/);
  });

  it("case 6: journal に op=archive → op=restore の 2 件が記録される", async () => {
    const { writer, journal, filePath, content } = buildEnv();
    const hash = sha256(content);

    const { archivePath } = await writer.archive(filePath, TASKS_DIR, hash);
    await writer.restore(archivePath, TASKS_DIR);

    const entries = await journal.readAll();
    expect(entries.length).toBe(2);
    expect(entries[0]!.op).toBe("archive");
    expect(entries[0]!.beforeData).toMatchObject({ from: filePath });
    expect(entries[0]!.afterData).toMatchObject({ to: archivePath });
    expect(entries[1]!.op).toBe("restore");
    expect(entries[1]!.beforeData).toMatchObject({ from: archivePath });
    expect(entries[1]!.afterData).toMatchObject({ to: `${TASKS_DIR}/K-0001-test.md` });
  });
});
