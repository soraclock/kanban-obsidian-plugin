import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { WriteJournal } from "../../src/data/WriteJournal";
import { TaskWriter } from "../../src/data/TaskWriter";
import { sha256, ConflictError } from "../../src/data/ContentHash";
import { MAX_FILE_SIZE_BYTES } from "../../src/data/Constants";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const JOURNAL_PATH = `${TASKS_DIR}/.kanban-journal.jsonl`;

function makeTaskContent(overrides: Record<string, unknown> = {}): string {
  const fm: Record<string, unknown> = {
    id: "K-0001",
    title: "テストタスク",
    status: "未着手",
    assignee: "花木",
    priority: "P1",
    due: "2026-05-20",
    created: "2026-05-11",
    updated: "2026-05-11",
    tags: [],
    order: 1,
    ...overrides,
  };
  return matter.stringify("\n本文テキスト\n", fm);
}

function buildEnv(initialFiles: Record<string, string> = {}) {
  const filePath = `${TASKS_DIR}/K-0001-test.md`;
  const content = makeTaskContent();
  const { app, files } = makeFakeApp({
    [filePath]: content,
    ...initialFiles,
  });
  const pathLock = new PathLock();
  const journal = new WriteJournal(
    app.vault as never,
    JOURNAL_PATH,
    pathLock,
  );
  const writer = new TaskWriter(app as never, pathLock, journal);
  const hash = sha256(content);
  return { app, files, writer, journal, filePath, hash };
}

describe("TaskWriter.updateTask integration", () => {
  it("case 1: frontmatter + body 両方変更 → vault.modify が呼ばれ hash が変わる", async () => {
    const { files, writer, filePath, hash } = buildEnv();
    const beforeContent = files[filePath]!;

    const result = await writer.updateTask(filePath, hash, {
      frontmatter: { title: "新タイトル" },
      bodyMarkdown: "\n変更後の本文\n",
    });

    expect(result.newHash).not.toBe(hash);
    const afterContent = files[filePath]!;
    expect(afterContent).not.toBe(beforeContent);
    const parsed = matter(afterContent);
    expect(parsed.data.title).toBe("新タイトル");
    expect(parsed.content).toContain("変更後の本文");
  });

  it("case 2: hash mismatch → ConflictError を throw", async () => {
    const { writer, filePath } = buildEnv();
    await expect(
      writer.updateTask(filePath, "wrong-hash-value", {
        frontmatter: { title: "変更" },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("case 3: bodyMarkdown undefined → 本文は元のまま", async () => {
    const { files, writer, filePath, hash } = buildEnv();

    await writer.updateTask(filePath, hash, {
      frontmatter: { title: "タイトルのみ変更" },
      // bodyMarkdown を渡さない
    });

    const parsed = matter(files[filePath]!);
    expect(parsed.data.title).toBe("タイトルのみ変更");
    // 本文は変わっていない
    expect(parsed.content).toContain("本文テキスト");
  });

  it("case 4: allowlist 外 key (id, created) は無視される", async () => {
    const { files, writer, filePath, hash } = buildEnv();
    const originalParsed = matter(files[filePath]!);
    const originalId = originalParsed.data.id;
    const originalCreated = originalParsed.data.created;

    await writer.updateTask(filePath, hash, {
      frontmatter: {
        title: "更新タイトル",
        id: "K-9999" as never,
        created: "2000-01-01" as never,
      } as never,
    });

    const parsed = matter(files[filePath]!);
    expect(parsed.data.title).toBe("更新タイトル");
    // allowlist 外なので id / created は変わらない
    expect(parsed.data.id).toBe(originalId);
    expect(parsed.data.created).toBe(originalCreated);
  });

  it("case 5: DANGEROUS_FRONTMATTER_KEYS (__proto__) は保存後に own key として存在しない", async () => {
    // __proto__ をキーとして YAML に直接書き込んだ frontmatter を準備する。
    // matter.stringify は Object spread で __proto__ を扱えないため、生の YAML 文字列で作る。
    const dangerousContent = `---\nid: K-0001\ntitle: テスト\nstatus: 未着手\nassignee: 花木\npriority: P1\ncreated: "2026-05-11"\nupdated: "2026-05-11"\ntags: []\norder: 1\n__proto__: malicious\n---\n\n本文\n`;
    const filePath = `${TASKS_DIR}/K-0001-test.md`;
    const { app, files: fls } = makeFakeApp({ [filePath]: dangerousContent });
    const pl = new PathLock();
    const jrn = new WriteJournal(app.vault as never, JOURNAL_PATH, pl);
    const tw = new TaskWriter(app as never, pl, jrn);
    const h = sha256(dangerousContent);

    await tw.updateTask(filePath, h, { frontmatter: { title: "クリーン" } });

    const parsed = matter(fls[filePath]!);
    // __proto__ が own property として残っていないことを確認
    expect(Object.prototype.hasOwnProperty.call(parsed.data, "__proto__")).toBe(false);
    expect(parsed.data.title).toBe("クリーン");
  });

  it("case 6: bodyMarkdown 1MB 超で reject", async () => {
    const { writer, filePath, hash } = buildEnv();
    const huge = "x".repeat(MAX_FILE_SIZE_BYTES + 1);
    await expect(
      writer.updateTask(filePath, hash, { bodyMarkdown: huge }),
    ).rejects.toThrow(/size.*exceeds limit/);
  });

  it("case 7: 保存後 frontmatter に updated が今日の日付で付与される", async () => {
    const { files, writer, filePath, hash } = buildEnv();
    const today = new Date();
    const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    await writer.updateTask(filePath, hash, {
      frontmatter: { title: "更新" },
    });

    const parsed = matter(files[filePath]!);
    expect(parsed.data.updated).toBe(todayYmd);
  });

  it("case 8: journal に op:updateTask が 1 件記録される", async () => {
    const { writer, journal, filePath, hash } = buildEnv();

    const beforeEntries = await journal.readAll();
    await writer.updateTask(filePath, hash, {
      frontmatter: { title: "journal テスト" },
    });
    const afterEntries = await journal.readAll();

    expect(afterEntries.length).toBe(beforeEntries.length + 1);
    const last = afterEntries[afterEntries.length - 1]!;
    expect(last.op).toBe("updateTask");
    expect(last.path).toBe(filePath);
  });
});
