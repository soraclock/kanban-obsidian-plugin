import { describe, it, expect } from "vitest";
import { parseBody, buildBody, stripWikilink, wrapWikilink } from "../../src/data/TaskBodyFormat";

describe("parseBody", () => {
  it("parses template structure (背景 / 次のアクション / メモ)", () => {
    const md = [
      "",
      "## 背景",
      "",
      "ブログ#1 公開のため素材待ち",
      "",
      "## 次のアクション",
      "- [ ] 写真の場所を共有",
      "- [x] キービジュアル受領",
      "",
      "## メモ",
      "",
      "P0 #2 と連動",
      "",
    ].join("\n");
    const r = parseBody(md);
    expect(r.description).toBe("ブログ#1 公開のため素材待ち");
    expect(r.subtasks).toEqual([
      { text: "写真の場所を共有", checked: false },
      { text: "キービジュアル受領", checked: true },
    ]);
    expect(r.memo).toBe("P0 #2 と連動");
  });

  it("handles empty body", () => {
    expect(parseBody("")).toEqual({ description: "", subtasks: [], memo: "" });
  });

  it("preserves unknown sections into memo tail", () => {
    const md = [
      "## 背景",
      "AAA",
      "",
      "## 進捗ログ",
      "5/10 着手",
      "",
      "## メモ",
      "BBB",
    ].join("\n");
    const r = parseBody(md);
    expect(r.description).toBe("AAA");
    expect(r.memo).toContain("BBB");
    expect(r.memo).toContain("## 進捗ログ");
    expect(r.memo).toContain("5/10 着手");
  });

  it("captures non-checkbox lines in 次のアクション as memo tail", () => {
    const md = [
      "## 次のアクション",
      "備考: 来週レビュー",
      "- [ ] 設計レビュー",
      "",
      "## メモ",
      "MMM",
    ].join("\n");
    const r = parseBody(md);
    expect(r.subtasks).toEqual([{ text: "設計レビュー", checked: false }]);
    expect(r.memo).toContain("MMM");
    expect(r.memo).toContain("備考: 来週レビュー");
  });

  it("handles checked variations [ ] [x] [X]", () => {
    const md = [
      "## 次のアクション",
      "- [ ] 未チェック",
      "- [x] 小文字 x",
      "- [X] 大文字 X",
    ].join("\n");
    const r = parseBody(md);
    expect(r.subtasks).toEqual([
      { text: "未チェック", checked: false },
      { text: "小文字 x", checked: true },
      { text: "大文字 X", checked: true },
    ]);
  });

  it("handles missing sections gracefully", () => {
    const r = parseBody("## メモ\nonly memo here\n");
    expect(r.description).toBe("");
    expect(r.subtasks).toEqual([]);
    expect(r.memo).toBe("only memo here");
  });

  it("treats preamble text as memo prefix", () => {
    const md = ["preamble line", "", "## 背景", "BBB"].join("\n");
    const r = parseBody(md);
    expect(r.description).toBe("BBB");
    expect(r.memo).toBe("preamble line");
  });
});

describe("buildBody", () => {
  it("emits template-compatible markdown", () => {
    const md = buildBody({
      description: "背景文",
      subtasks: [
        { text: "未完了", checked: false },
        { text: "完了", checked: true },
      ],
      memo: "備考",
    });
    expect(md).toContain("## 背景\n\n背景文");
    expect(md).toContain("## 次のアクション\n- [ ] 未完了\n- [x] 完了");
    expect(md).toContain("## メモ\n\n備考");
  });

  it("omits empty sections entirely", () => {
    const md = buildBody({ description: "", subtasks: [], memo: "備考のみ" });
    expect(md).not.toContain("## 背景");
    expect(md).not.toContain("## 次のアクション");
    expect(md).toContain("## メモ\n\n備考のみ");
  });

  it("returns empty string when all sections are empty", () => {
    expect(buildBody({ description: "", subtasks: [], memo: "" })).toBe("");
  });
});

describe("parseBody / buildBody round trip", () => {
  it("preserves the canonical structure end-to-end", () => {
    const initial = {
      description: "B",
      subtasks: [{ text: "T1", checked: false }, { text: "T2", checked: true }],
      memo: "M",
    };
    const md = buildBody(initial);
    const r = parseBody(md);
    expect(r.description).toBe(initial.description);
    expect(r.subtasks).toEqual(initial.subtasks);
    expect(r.memo).toBe(initial.memo);
  });

  it("preserves unknown section content through round trip via memo tail", () => {
    // 1 度目: 未知 section が memo 末尾に取り込まれる → build 後の memo には `## 進捗` が
    // 含まれた状態。再度 parse すると "## 進捗" は memo セクション内に "## 進捗" と書かれ
    // ているだけなので、splitSections は新しい subsection と認識する。
    // 期待動作: 元の `## 進捗` 内容は失われずに memo に残るが、配置は変わる可能性あり。
    const md1 = ["## 背景", "X", "", "## 進捗", "Y"].join("\n");
    const r1 = parseBody(md1);
    expect(r1.memo).toContain("## 進捗");
    const md2 = buildBody(r1);
    // 2 度目の parse でも内容 Y が残る (description/memo どちらに入っても OK、消えないこと)
    const r2 = parseBody(md2);
    const allText = `${r2.description}\n${r2.memo}`;
    expect(allText).toContain("Y");
  });
});

describe("stripWikilink / wrapWikilink", () => {
  it("strip removes [[ ]]", () => {
    expect(stripWikilink("[[board]]")).toBe("board");
    expect(stripWikilink("[[2026年04月18日_メモ]]")).toBe("2026年04月18日_メモ");
  });
  it("strip leaves non-wikilink intact", () => {
    expect(stripWikilink("plain")).toBe("plain");
    expect(stripWikilink("not [[full link]] form")).toBe("not [[full link]] form");
  });
  it("wrap adds [[ ]] when missing", () => {
    expect(wrapWikilink("board")).toBe("[[board]]");
    expect(wrapWikilink("  with spaces  ")).toBe("[[with spaces]]");
  });
  it("wrap leaves already-wrapped unchanged", () => {
    expect(wrapWikilink("[[board]]")).toBe("[[board]]");
  });
  it("wrap returns empty for empty input", () => {
    expect(wrapWikilink("")).toBe("");
    expect(wrapWikilink("   ")).toBe("");
  });
});
