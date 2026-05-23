import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { WriteJournal } from "../../src/data/WriteJournal";
import { TaskCreator } from "../../src/data/TaskCreator";
import { makeFakeApp } from "../helpers/fakeApp";

const TASKS_DIR = "秘書/tasks";
const README_PATH = `${TASKS_DIR}/_README.md`;
const JOURNAL_PATH = `${TASKS_DIR}/.kanban-journal.jsonl`;

function makeReadme(nextNum: number): string {
  return `# タスクボード\n\n次のID: **K-${String(nextNum).padStart(4, "0")}**\n`;
}

function buildEnv(extraFiles: Record<string, string> = {}, defaultAssignee = "花木") {
  const { app, files } = makeFakeApp({
    [README_PATH]: makeReadme(3),
    ...extraFiles,
  });
  const pathLock = new PathLock();
  const journal = new WriteJournal(app.vault as never, JOURNAL_PATH, pathLock);
  const creator = new TaskCreator(
    app as never,
    TASKS_DIR,
    pathLock,
    journal,
    undefined,
    undefined,
    undefined,
    () => defaultAssignee,
  );
  return { app, files, creator };
}

describe("TaskCreator", () => {
  it("case 1: 正常作成 — ファイルが作られ _README.md の次のID が +1 される", async () => {
    const { files, creator } = buildEnv();

    const result = await creator.createTask({ title: "テストタスク", status: "未着手" });

    expect(result.newId).toBe("K-0003");
    expect(result.newFilePath).toContain("K-0003-");
    expect(files[result.newFilePath]).toBeDefined();
    // README が K-0004 に更新されている
    expect(files[README_PATH]).toContain("K-0004");
  });

  it("case 2: slug 生成 — 日本語タイトルが kebab 化される", async () => {
    const { creator } = buildEnv();

    // ー (U+30FC) はカタカナ範囲 ァ-ヶ の外なので '-' に変換される
    const result = await creator.createTask({ title: "週次レビュー会議", status: "進行中" });

    // K-0003- で始まり、日本語部分を含む slug が入っている
    expect(result.newFilePath).toContain("K-0003-");
    expect(result.newFilePath).toContain("週次レビュ");
    expect(result.newFilePath).toContain("会議");
  });

  it("case 3: slug 生成 — 英数字タイトル", async () => {
    const { creator } = buildEnv();

    const result = await creator.createTask({ title: "Fix bug in API", status: "未着手" });

    expect(result.newFilePath).toContain("Fix-bug-in-API");
  });

  it("case 4: ID 衝突 — 同 path が存在したら +1 で再採番", async () => {
    // K-0003-テスト.md を先に作っておく
    const { files, creator } = buildEnv({
      [`${TASKS_DIR}/K-0003-テスト.md`]: "dummy",
    });

    const result = await creator.createTask({ title: "テスト", status: "未着手" });

    // K-0003 が衝突するので K-0004 になる
    expect(result.newId).toBe("K-0004");
    expect(files[README_PATH]).toContain("K-0005");
  });

  it("case 4b (v0.6.7): 旧形式 K-NNNN_*.md 衝突 — アンダースコア区切りでも採番が回避される", async () => {
    // 他 vault から移行された旧形式: K-0003_神楽会の全体方針.md
    const { files, creator } = buildEnv({
      [`${TASKS_DIR}/K-0003_神楽会の全体方針.md`]: "dummy",
    });

    const result = await creator.createTask({ title: "新規", status: "未着手" });

    // 旧形式 K-0003_ も衝突として検知されるので K-0004 で採番
    expect(result.newId).toBe("K-0004");
    expect(result.newFilePath).toContain("K-0004-");
    expect(files[README_PATH]).toContain("K-0005");
  });

  it("case 4c (v0.6.7): 既存ファイルの max ID が README より大きい場合は自動で max+1 へ進む", async () => {
    // README は K-0003 だが、実態は K-0114 までタスクが入っている移行 vault のケース
    const existingFiles: Record<string, string> = {};
    for (let i = 1; i <= 114; i++) {
      existingFiles[`${TASKS_DIR}/K-${String(i).padStart(4, "0")}_既存タスク.md`] = "dummy";
    }
    const { files, creator } = buildEnv(existingFiles);

    const result = await creator.createTask({ title: "新規", status: "未着手" });

    // K-0115 で採番、README も K-0116 に書き戻される
    expect(result.newId).toBe("K-0115");
    expect(files[README_PATH]).toContain("K-0116");
  });

  it("case 4d (v0.6.7): 新旧形式混在 vault でも全 ID を見て max+1 を取る", async () => {
    const { files, creator } = buildEnv({
      [`${TASKS_DIR}/K-0050_旧形式タスク.md`]: "dummy",
      [`${TASKS_DIR}/K-0080-新形式タスク.md`]: "dummy",
      [`${TASKS_DIR}/K-0010.md`]: "dummy", // slug 無し形式
    });

    const result = await creator.createTask({ title: "新規", status: "未着手" });

    expect(result.newId).toBe("K-0081");
    expect(files[README_PATH]).toContain("K-0082");
  });

  it("case 5: path validation — 特殊文字タイトルでも slug が空にならない (untitled fallback)", async () => {
    const { creator } = buildEnv();

    // 許可外文字のみのタイトル → slug = "untitled"
    const result = await creator.createTask({ title: "!!!", status: "未着手" });

    expect(result.newFilePath).toContain("untitled");
  });

  it("case 6: frontmatter 構造 — status / priority / assignee / due などが正しく入る", async () => {
    const { files, creator } = buildEnv();

    const result = await creator.createTask({
      title: "フロントマターテスト",
      status: "確認待ち",
      priority: "P1",
      assignee: "テストユーザー",
    });

    const content = files[result.newFilePath]!;
    const parsed = matter(content);
    expect(parsed.data.id).toBe("K-0003");
    expect(parsed.data.title).toBe("フロントマターテスト");
    expect(parsed.data.status).toBe("確認待ち");
    expect(parsed.data.priority).toBe("P1");
    expect(parsed.data.assignee).toBe("テストユーザー");
    expect(parsed.data.due).toBeNull();
    expect(parsed.data.completedAt).toBeNull();
    expect(parsed.data.estimateHours).toBeNull();
    expect(parsed.data.actualHours).toBeNull();
    expect(parsed.data.recurrence).toBeNull();
    expect(Array.isArray(parsed.data.tags)).toBe(true);
  });

  it("case 6b: デフォルト値 — priority=P2 / assignee は設定値 (花木) が入る", async () => {
    const { files, creator } = buildEnv();

    const result = await creator.createTask({ title: "デフォルトテスト", status: "未着手" });

    const parsed = matter(files[result.newFilePath]!);
    expect(parsed.data.priority).toBe("P2");
    expect(parsed.data.assignee).toBe("花木");
  });

  it("case 6c (v0.6.6): defaultAssignee 設定が空文字なら assignee は空文字になる", async () => {
    const { files, creator } = buildEnv({}, "");

    const result = await creator.createTask({ title: "空欄テスト", status: "未着手" });

    const parsed = matter(files[result.newFilePath]!);
    expect(parsed.data.assignee).toBe("");
  });

  it("case 6d (v0.6.6): defaultAssignee 設定値が反映される", async () => {
    const { files, creator } = buildEnv({}, "山田");

    const result = await creator.createTask({ title: "別名テスト", status: "未着手" });

    const parsed = matter(files[result.newFilePath]!);
    expect(parsed.data.assignee).toBe("山田");
  });

  it("case 7: _README.md に次のID がない場合はエラー", async () => {
    const { creator } = buildEnv({
      [README_PATH]: "# タスクボード\n\n次のIDが書かれていない\n",
    });

    await expect(
      creator.createTask({ title: "エラーテスト", status: "未着手" }),
    ).rejects.toThrow("次のID");
  });

  it("case 8: 空 title で reject", async () => {
    const { creator } = buildEnv();

    await expect(
      creator.createTask({ title: "", status: "未着手" }),
    ).rejects.toThrow("title is required");

    await expect(
      creator.createTask({ title: "   ", status: "未着手" }),
    ).rejects.toThrow("title is required");
  });

  it("case 9: vault.create が throw した場合は README が書き戻されない", async () => {
    const { app, files, creator } = buildEnv();
    const originalReadme = files[README_PATH]!;
    const pathLock = new PathLock();
    const journal = new WriteJournal(app.vault as never, JOURNAL_PATH, pathLock);
    // vault.create を throw させる
    (app.vault as unknown as Record<string, unknown>).create = async () => {
      throw new Error("disk full");
    };

    await expect(
      creator.createTask({ title: "失敗タスク", status: "未着手" }),
    ).rejects.toThrow("disk full");

    // README は書き戻されていない（K-0003 のまま）
    expect(files[README_PATH]).toBe(originalReadme);
    // journal に createTask entry が append されていない
    const entries = await journal.readAll();
    expect(entries.filter((e) => e.op === "createTask")).toHaveLength(0);
  });

  it("case 10: 絵文字のみのタイトルは untitled fallback になる", async () => {
    const { creator } = buildEnv();

    const result = await creator.createTask({ title: "🎉🎉🎉", status: "未着手" });

    expect(result.newFilePath).toMatch(/K-\d{4}-untitled\.md$/);
  });

  it("case 11a: _README.md が無い vault でも自動初期化されて K-0001 で作成成功 (新規ユーザー)", async () => {
    // 全くの空 vault — README も無い、フォルダも無い
    const { app, files } = makeFakeApp({});
    const pathLock = new PathLock();
    const journal = new WriteJournal(app.vault as never, JOURNAL_PATH, pathLock);
    const creator = new TaskCreator(app as never, TASKS_DIR, pathLock, journal);

    const result = await creator.createTask({ title: "初めてのタスク", status: "未着手" });

    expect(result.newId).toBe("K-0001");
    expect(files[result.newFilePath]).toBeDefined();
    // _README.md が自動生成され、次のID が K-0002 になっている
    expect(files[README_PATH]).toBeDefined();
    expect(files[README_PATH]).toContain("K-0002");
  });

  it("case 11 (v0.6.7 改): 大量の既存ファイルがあっても max+1 ジャンプで一発採番", async () => {
    // 旧テストは 100 回連続衝突 → throw を期待していたが、v0.6.7 で max+1 ジャンプを入れたため
    // この事前条件では一発成功するように変わった。100 回連続衝突ガード自体は while ループの
    // safety net としてコード上に残る（race condition でしか発火しない）。
    const existingFiles: Record<string, string> = {};
    for (let i = 3; i <= 103; i++) {
      existingFiles[`${TASKS_DIR}/K-${String(i).padStart(4, "0")}-untitled.md`] = "dummy";
    }
    const { creator } = buildEnv(existingFiles);

    const result = await creator.createTask({ title: "新規", status: "未着手" });
    // README は K-0003 だが max=103 なので K-0104 へ一発ジャンプ
    expect(result.newId).toBe("K-0104");
  });
});
