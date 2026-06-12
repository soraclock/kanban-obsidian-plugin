import { describe, it, expect } from "vitest";
import {
  assertValidStatus,
  sanitizeFrontmatterPatch,
  splitFrontmatterAndBody,
  isSafeRelativePath,
} from "../../src/data/TaskWriter";

describe("assertValidStatus", () => {
  it("accepts each canonical status", () => {
    expect(() => assertValidStatus("未着手")).not.toThrow();
    expect(() => assertValidStatus("進行中")).not.toThrow();
    expect(() => assertValidStatus("確認待ち")).not.toThrow();
    expect(() => assertValidStatus("完了")).not.toThrow();
    expect(() => assertValidStatus("凍結")).not.toThrow();
  });

  it("rejects unknown value", () => {
    expect(() => assertValidStatus("Done")).toThrow(/invalid status/);
    expect(() => assertValidStatus("")).toThrow(/invalid status/);
    expect(() => assertValidStatus("__proto__")).toThrow(/invalid status/);
  });

  it("rejects path-traversal style payload (review#Major Phase 5c 防御)", () => {
    expect(() => assertValidStatus("../../etc/passwd")).toThrow(/invalid status/);
  });

  it("rejects trailing whitespace (表記揺れは事前に normalize する想定)", () => {
    expect(() => assertValidStatus("未着手 ")).toThrow(/invalid status/);
    expect(() => assertValidStatus(" 未着手")).toThrow(/invalid status/);
  });
});

describe("sanitizeFrontmatterPatch (Phase 3)", () => {
  it("returns empty for undefined / no keys", () => {
    expect(sanitizeFrontmatterPatch(undefined)).toEqual({});
    expect(sanitizeFrontmatterPatch({})).toEqual({});
  });

  it("passes through valid editable fields", () => {
    const out = sanitizeFrontmatterPatch({
      title: "T",
      status: "進行中",
      priority: "P1",
      assignee: "A",
      due: "2026-05-15",
      model: "opus",
      tags: ["x", "y"],
      related: ["z"],
      order: 1.5,
    });
    expect(out).toEqual({
      title: "T",
      status: "進行中",
      priority: "P1",
      assignee: "A",
      due: "2026-05-15",
      model: "opus",
      tags: ["x", "y"],
      related: ["z"],
      order: 1.5,
    });
  });

  it("drops invalid status / priority", () => {
    expect(sanitizeFrontmatterPatch({ status: "Done" as unknown as never })).toEqual({});
    expect(sanitizeFrontmatterPatch({ priority: "P9" as unknown as never })).toEqual({});
  });

  it("accepts null for due and model", () => {
    expect(sanitizeFrontmatterPatch({ due: null })).toEqual({ due: null });
    expect(sanitizeFrontmatterPatch({ model: null })).toEqual({ model: null });
  });

  it("drops bad due format", () => {
    expect(sanitizeFrontmatterPatch({ due: "2026/05/15" as unknown as string })).toEqual({});
    expect(sanitizeFrontmatterPatch({ due: "" as unknown as string })).toEqual({});
  });

  it("drops non-string-array tags / related", () => {
    expect(sanitizeFrontmatterPatch({ tags: [1, 2] as unknown as string[] })).toEqual({});
    expect(sanitizeFrontmatterPatch({ tags: "x,y" as unknown as string[] })).toEqual({});
  });

  it("drops unknown / dangerous keys silently", () => {
    const out = sanitizeFrontmatterPatch({
      title: "ok",
      __proto__: { polluted: true },
      constructor: "X",
      id: "K-9999",
      created: "2026-01-01",
    } as unknown as never);
    expect(out).toEqual({ title: "ok" });
  });

  it("drops infinite / NaN order", () => {
    expect(sanitizeFrontmatterPatch({ order: Number.POSITIVE_INFINITY })).toEqual({});
    expect(sanitizeFrontmatterPatch({ order: Number.NaN })).toEqual({});
  });

  // v0.6.14: title: "" が書かれると schema audit エラー + ボードから消えるバグの再発防止
  it("drops empty / whitespace-only title (schema requires min 1)", () => {
    expect(sanitizeFrontmatterPatch({ title: "" })).toEqual({});
    expect(sanitizeFrontmatterPatch({ title: "   " })).toEqual({});
    expect(sanitizeFrontmatterPatch({ title: "\t\n" })).toEqual({});
  });

  it("keeps non-empty title and allows empty assignee", () => {
    expect(sanitizeFrontmatterPatch({ title: "NDA" })).toEqual({ title: "NDA" });
    // assignee は schema 上 min(1) 制約がないため空文字を許容する (現行仕様)
    expect(sanitizeFrontmatterPatch({ assignee: "" })).toEqual({ assignee: "" });
  });
});

describe("splitFrontmatterAndBody (Phase 3)", () => {
  it("splits standard frontmatter + body", () => {
    const content = "---\nid: K-0001\ntitle: T\n---\nbody text here\n";
    const { fmRaw, body } = splitFrontmatterAndBody(content);
    expect(fmRaw).toBe("---\nid: K-0001\ntitle: T\n---\n");
    expect(body).toBe("body text here\n");
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nid: K-0001\r\n---\r\nbody";
    const { fmRaw, body } = splitFrontmatterAndBody(content);
    expect(fmRaw).toBe("---\r\nid: K-0001\r\n---\r\n");
    expect(body).toBe("body");
  });

  it("returns empty fmRaw when no frontmatter", () => {
    const content = "just body text";
    const { fmRaw, body } = splitFrontmatterAndBody(content);
    expect(fmRaw).toBe("");
    expect(body).toBe("just body text");
  });

  it("returns empty fmRaw for unterminated frontmatter", () => {
    // 開始 --- だけで終端が無いケース → 安全側に倒して body 全体
    const content = "---\nid: K-0001\nfailure to close";
    const { fmRaw, body } = splitFrontmatterAndBody(content);
    expect(fmRaw).toBe("");
    expect(body).toBe(content);
  });
});

describe("sanitizeFrontmatterPatch — own property only (codex#6)", () => {
  it("rejects allowlist key inherited from prototype", () => {
    class MaliciousBase {}
    (MaliciousBase.prototype as Record<string, unknown>).title = "polluted via prototype";
    const inst = new (MaliciousBase as unknown as { new (): Record<string, unknown> })();
    // own property は無く、prototype 経由でのみ title が見える状態
    expect(Object.prototype.hasOwnProperty.call(inst, "title")).toBe(false);
    expect(inst.title).toBe("polluted via prototype");
    const out = sanitizeFrontmatterPatch(inst as never);
    expect(out).toEqual({});
  });

  it("still accepts own properties of the same name", () => {
    const patch = { title: "ok" } as never;
    expect(sanitizeFrontmatterPatch(patch)).toEqual({ title: "ok" });
  });
});

describe("isSafeRelativePath (Phase 3 archive path validation)", () => {
  it("accepts normal vault relative paths", () => {
    expect(isSafeRelativePath("秘書/tasks/K-0001.md")).toBe(true);
    expect(isSafeRelativePath("a/b/c.md")).toBe(true);
  });
  it("rejects absolute paths", () => {
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("\\Windows\\system32")).toBe(false);
  });
  it("rejects parent-segment traversal", () => {
    expect(isSafeRelativePath("../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("秘書/../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("a/./b")).toBe(false);
  });
  it("rejects empty / leading-slash-like cases", () => {
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("//doubled")).toBe(false);
  });
  it("rejects control chars / backslash (half-width space is allowed)", () => {
    expect(isSafeRelativePath("a\tb")).toBe(false);
    expect(isSafeRelativePath("a\\b")).toBe(false);
  });
  it("accepts paths with half-width space (Obsidian vault paths)", () => {
    // codex round 2 反映: 「My Tasks/...」「秘書/tasks/K-0001 sample.md」は正常
    expect(isSafeRelativePath("秘書/tasks/K-0001 sample.md")).toBe(true);
    expect(isSafeRelativePath("My Tasks/K-0001.md")).toBe(true);
  });
});
