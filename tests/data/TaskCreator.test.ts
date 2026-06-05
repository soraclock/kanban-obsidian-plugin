import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { PathLock } from "../../src/data/PathLock";
import { WriteJournal } from "../../src/data/WriteJournal";
import { TaskCreator } from "../../src/data/TaskCreator";
import { TaskFrontmatterSchema } from "../../src/data/TaskSchema";
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
  it("case 1 (v0.6.13 案A): 正常作成 — 実ファイルが無ければ K-0001 から採番し README を +1 する", async () => {
    // 案A: README の「次のID K-0003」は参考値。実在タスクファイルが 0 件なので採番は K-0001。
    const { files, creator } = buildEnv();

    const result = await creator.createTask({ title: "テストタスク", status: "未着手" });

    expect(result.newId).toBe("K-0001");
    expect(result.newFilePath).toContain("K-0001-");
    expect(files[result.newFilePath]).toBeDefined();
    // README が採番値 +1 = K-0002 に更新されている
    expect(files[README_PATH]).toContain("K-0002");
  });

  it("case 2: slug 生成 — 日本語タイトルが kebab 化される", async () => {
    const { creator } = buildEnv();

    // ー (U+30FC) はカタカナ範囲 ァ-ヶ の外なので '-' に変換される
    const result = await creator.createTask({ title: "週次レビュー会議", status: "進行中" });

    // K-0001- で始まり（実ファイル0件のため案Aで先頭採番）、日本語部分を含む slug が入っている
    expect(result.newFilePath).toContain("K-0001-");
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
    expect(parsed.data.id).toBe("K-0001");
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

  it("case 7 (v0.6.13 案A): _README.md に次のID 行が無くても throw せず採番し行を自己修復する", async () => {
    // 配布先ユーザーが README を編集して「次のID」行を消した状態。従来はここで
    // 「次のID が見つかりません」エラーで詰まっていた。案A では実ファイル基準で採番継続。
    const { files, creator } = buildEnv({
      [README_PATH]: "# タスクボード\n\n次のIDが書かれていない\n",
    });

    const result = await creator.createTask({ title: "自己修復テスト", status: "未着手" });

    // 実ファイル0件なので K-0001 で採番成功
    expect(result.newId).toBe("K-0001");
    // README に「次のID: **K-0002**」行が挿入されている（自己修復）
    expect(files[README_PATH]).toMatch(/次のID:\s*\*\*K-0002\*\*/);
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

  it("case 12: createdTask が返る — filePath / id / status / contentHash が正しい", async () => {
    const { creator } = buildEnv();

    const result = await creator.createTask({ title: "即時反映テスト", status: "進行中", priority: "P1" });

    expect(result.createdTask).toBeDefined();
    expect(result.createdTask.filePath).toBe(result.newFilePath);
    expect(result.createdTask.id).toBe(result.newId);
    expect(result.createdTask.status).toBe("進行中");
    expect(result.createdTask.priority).toBe("P1");
    expect(result.createdTask.title).toBe("即時反映テスト");
    // contentHash は空文字ではなく sha256 文字列
    expect(result.createdTask.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // bodyMarkdown は空でない
    expect(result.createdTask.bodyMarkdown).toContain("## 背景");
  });

  it("case 13 (v0.6.9 回帰): K-10000 以上の id が TaskFrontmatterSchema で parse される", () => {
    const validId = "K-10000";
    const parsed = TaskFrontmatterSchema.safeParse({
      id: validId,
      title: "大番号タスク",
      status: "未着手",
      assignee: "",
      priority: "P2",
      created: "2026-01-01",
      updated: "2026-01-01",
      tags: [],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toBe("K-10000");
  });

  it("case 13b (v0.6.9 回帰): K-99999 も schema parse が通る", () => {
    const parsed = TaskFrontmatterSchema.safeParse({
      id: "K-99999",
      title: "超大番号タスク",
      status: "完了",
      assignee: "テスト",
      priority: "P0",
      created: "2026-06-01",
      updated: "2026-06-01",
      tags: ["test"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toBe("K-99999");
  });

  it("case 13c (v0.6.9 回帰): 4 桁未満 K-001 は schema で reject される", () => {
    const parsed = TaskFrontmatterSchema.safeParse({
      id: "K-001",
      title: "短い番号",
      status: "未着手",
      assignee: "",
      priority: "P2",
      created: "2026-01-01",
      updated: "2026-01-01",
      tags: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("case 14: createdTask が 5 桁 ID (K-10001) でも正しく構築される", async () => {
    // README の次のIDが K-10000 より大きい既存ファイルを用意して K-10001 を採番させる
    const existingFiles: Record<string, string> = {};
    for (let i = 1; i <= 9999; i++) {
      existingFiles[`${TASKS_DIR}/K-${String(i).padStart(4, "0")}-dummy.md`] = "dummy";
    }
    existingFiles[`${TASKS_DIR}/K-10000-dummy.md`] = "dummy";
    const { creator } = buildEnv(existingFiles);

    const result = await creator.createTask({ title: "5桁IDテスト", status: "未着手" });

    expect(result.newId).toBe("K-10001");
    expect(result.createdTask.id).toBe("K-10001");
    expect(result.createdTask.filePath).toContain("K-10001-");
    // TaskFrontmatterSchema で parse 済みのはずなので contentHash が存在する
    expect(result.createdTask.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("case 15 (v0.6.13 案A): 最大IDタスクを削除した後は番号を使い回す（実ファイル基準採番）", async () => {
    // K-0005 まで存在 → 最大 K-0005 を消した状態を「K-0004 までの実ファイル + README=K-0006」で再現。
    // 案A は README(K-0006) を無視し実ファイル最大(K-0004)+1 = K-0005 を採番する。
    const { files, creator } = buildEnv({
      [README_PATH]: makeReadme(6),
      [`${TASKS_DIR}/K-0003-foo.md`]: "dummy",
      [`${TASKS_DIR}/K-0004-bar.md`]: "dummy",
    });

    const result = await creator.createTask({ title: "使い回し", status: "未着手" });

    expect(result.newId).toBe("K-0005");
    expect(files[README_PATH]).toContain("K-0006");
  });

  it("case 16 (v0.6.13 案A): 途中のタスクを削除して欠番があっても最大+1で採番しエラーにならない", async () => {
    // K-0001 と K-0003 が存在、K-0002 は削除済み（欠番）。案A は最大(K-0003)+1 = K-0004。
    const { creator } = buildEnv({
      [`${TASKS_DIR}/K-0001-a.md`]: "dummy",
      [`${TASKS_DIR}/K-0003-c.md`]: "dummy",
    });

    const result = await creator.createTask({ title: "欠番あり", status: "未着手" });

    expect(result.newId).toBe("K-0004");
  });

  it("case 17 (v0.6.13 案A): _archive 配下のタスクとも ID 衝突しない（vault 全体を走査）", async () => {
    // top-level は K-0002 までだが、_archive に退避した K-0009 がある。
    // adapter.list（top-level のみ）だと K-0003 を採番して将来 _archive と衝突するが、
    // 案A は getMarkdownFiles で _archive も見るので最大(K-0009)+1 = K-0010 を採番する。
    const { creator } = buildEnv({
      [`${TASKS_DIR}/K-0002-top.md`]: "dummy",
      [`${TASKS_DIR}/_archive/2026-05/K-0009-archived.md`]: "dummy",
    });

    const result = await creator.createTask({ title: "アーカイブ衝突回避", status: "未着手" });

    expect(result.newId).toBe("K-0010");
  });
});
