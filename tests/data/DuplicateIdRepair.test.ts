import { describe, it, expect } from "vitest";
import {
  detectDuplicates,
  calcMaxId,
  planRepair,
  rewriteFrontmatterId,
  executeRepair,
} from "../../src/data/DuplicateIdRepair";
import { PathLock } from "../../src/data/PathLock";
import { SelfWriteTracker } from "../../src/data/SelfWriteTracker";
import { makeFakeApp } from "../helpers/fakeApp";

describe("detectDuplicates", () => {
  it("returns empty array when no duplicates", () => {
    expect(detectDuplicates(["K-0001-a.md", "K-0002-b.md"])).toEqual([]);
  });

  it("groups files with same ID number across new and old format", () => {
    const groups = detectDuplicates([
      "K-0001_神楽会の全体方針.md",
      "K-0001-あ.md",
      "K-0002_理念作成.md",
      "K-0002-2.md",
      "K-0003-unique.md",
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.idNum).toBe(1);
    // 旧形式 (アンダースコア) が先頭、新形式 (ハイフン) は振り直し対象側
    expect(groups[0]!.filenames).toEqual([
      "K-0001_神楽会の全体方針.md",
      "K-0001-あ.md",
    ]);
    expect(groups[1]!.idNum).toBe(2);
    expect(groups[1]!.filenames).toEqual([
      "K-0002_理念作成.md",
      "K-0002-2.md",
    ]);
  });

  it("ignores non-task files", () => {
    expect(
      detectDuplicates(["_README.md", "_テンプレート.md", "K-0001-a.md"]),
    ).toEqual([]);
  });

  it("returns 3-way duplicate group", () => {
    const groups = detectDuplicates([
      "K-0005_orig.md",
      "K-0005-dup1.md",
      "K-0005-dup2.md",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.filenames).toHaveLength(3);
  });
});

describe("calcMaxId", () => {
  it("returns 0 when no task files", () => {
    expect(calcMaxId(["_README.md"])).toBe(0);
    expect(calcMaxId([])).toBe(0);
  });

  it("returns the highest K-NNNN across formats", () => {
    expect(
      calcMaxId(["K-0001-a.md", "K-0050_old.md", "K-0080-new.md", "K-0010.md"]),
    ).toBe(80);
  });
});

describe("planRepair", () => {
  it("assigns sequential new IDs starting from maxExistingId + 1", () => {
    const groups = detectDuplicates([
      "K-0001_orig.md",
      "K-0001-dup.md",
      "K-0002_orig.md",
      "K-0002-dup.md",
    ]);
    const plans = planRepair(groups, 114);
    expect(plans).toEqual([
      {
        oldFilename: "K-0001-dup.md",
        newFilename: "K-0115-dup.md",
        oldIdNum: 1,
        newIdNum: 115,
      },
      {
        oldFilename: "K-0002-dup.md",
        newFilename: "K-0116-dup.md",
        oldIdNum: 2,
        newIdNum: 116,
      },
    ]);
  });

  it("uses 'renamed' fallback when filename has no slug", () => {
    const groups = detectDuplicates(["K-0005_orig.md", "K-0005.md"]);
    const plans = planRepair(groups, 10);
    expect(plans[0]!.newFilename).toBe("K-0011-renamed.md");
  });

  it("returns empty when there are no duplicates", () => {
    expect(planRepair([], 100)).toEqual([]);
  });
});

describe("rewriteFrontmatterId", () => {
  it("replaces id field while preserving other frontmatter and body", () => {
    const input = `---
id: K-0001
title: テスト
status: 未着手
priority: P2
assignee: 花木
created: "2026-05-01"
updated: "2026-05-01"
tags: []
---

本文セクション
## 背景
あいうえお
`;
    const result = rewriteFrontmatterId(input, "K-0115");
    expect(result).toContain("id: K-0115");
    expect(result).not.toContain("id: K-0001");
    expect(result).toContain("title: テスト");
    expect(result).toContain("本文セクション");
    expect(result).toContain("## 背景");
  });

  it("throws when frontmatter has no id", () => {
    const input = `---
title: 不正なファイル
---

本文
`;
    expect(() => rewriteFrontmatterId(input, "K-0115")).toThrow(
      /frontmatter に id がありません/,
    );
  });
});

describe("executeRepair (integration)", () => {
  const TASKS_DIR = "tasks";
  const validBody = (id: string) => `---
id: ${id}
title: テスト ${id}
status: 未着手
priority: P2
assignee: 花木
created: "2026-05-01"
updated: "2026-05-01"
tags: []
---

本文
`;

  it("renames file + rewrites frontmatter id, both succeeded", async () => {
    const { app, files } = makeFakeApp({
      [`${TASKS_DIR}/K-0001_orig.md`]: validBody("K-0001"),
      [`${TASKS_DIR}/K-0001-dup.md`]: validBody("K-0001"),
    });
    const tracker = new SelfWriteTracker();
    const lock = new PathLock();
    const plans = planRepair(
      detectDuplicates([
        "K-0001_orig.md",
        "K-0001-dup.md",
      ]),
      1,
    );

    const result = await executeRepair(
      app as never,
      TASKS_DIR,
      plans,
      tracker,
      lock,
    );

    expect(result.failed).toHaveLength(0);
    expect(result.succeeded).toHaveLength(1);
    // dup 側が K-0002 に振り直され、orig は据え置き
    expect(files[`${TASKS_DIR}/K-0002-dup.md`]).toContain("id: K-0002");
    expect(files[`${TASKS_DIR}/K-0001-dup.md`]).toBeUndefined();
    expect(files[`${TASKS_DIR}/K-0001_orig.md`]).toContain("id: K-0001");
  });

  it("logs failed plan when frontmatter is missing id", async () => {
    const { app, files } = makeFakeApp({
      [`${TASKS_DIR}/K-0005_orig.md`]: validBody("K-0005"),
      [`${TASKS_DIR}/K-0005-broken.md`]: `---\ntitle: id無し\n---\n本文\n`,
    });
    const tracker = new SelfWriteTracker();
    const lock = new PathLock();
    const plans = planRepair(
      detectDuplicates(["K-0005_orig.md", "K-0005-broken.md"]),
      5,
    );

    const result = await executeRepair(
      app as never,
      TASKS_DIR,
      plans,
      tracker,
      lock,
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("frontmatter に id がありません");
    // 元ファイルは残る（rename も modify もされない）
    expect(files[`${TASKS_DIR}/K-0005-broken.md`]).toBeDefined();
  });

  it("aborts plan when target newPath filename collides with an existing file", async () => {
    // 振り直し先のファイル名 (K-0006-dup.md) が既に存在するレアケース。
    // planRepair は filename ベースで採番するので通常は起きないが、ガードが効いていることの確認。
    const { app, files } = makeFakeApp({
      [`${TASKS_DIR}/K-0001_orig.md`]: validBody("K-0001"),
      [`${TASKS_DIR}/K-0001-dup.md`]: validBody("K-0001"),
      [`${TASKS_DIR}/K-0006-dup.md`]: validBody("K-0006"),
    });
    const tracker = new SelfWriteTracker();
    const lock = new PathLock();
    // planRepair に渡す既存 max を低めにして衝突パスを作る (実運用では max ID + 1 から振るので起きない)
    const plans = planRepair(
      detectDuplicates(["K-0001_orig.md", "K-0001-dup.md"]),
      5,
    );
    expect(plans[0]!.newFilename).toBe("K-0006-dup.md");

    const result = await executeRepair(
      app as never,
      TASKS_DIR,
      plans,
      tracker,
      lock,
    );

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("振り直し先が既に存在します");
    // 既存ファイルは無傷
    expect(files[`${TASKS_DIR}/K-0006-dup.md`]).toContain("id: K-0006");
    expect(files[`${TASKS_DIR}/K-0001-dup.md`]).toBeDefined();
  });
});
