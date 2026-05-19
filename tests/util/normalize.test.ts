import { describe, it, expect } from "vitest";
import { normalizeStatus, normalizeTag, statusHasVariance } from "../../src/util/normalize";

describe("normalizeStatus", () => {
  it("returns canonical status when exact match", () => {
    expect(normalizeStatus("未着手")).toBe("未着手");
    expect(normalizeStatus("進行中")).toBe("進行中");
    expect(normalizeStatus("確認待ち")).toBe("確認待ち");
    expect(normalizeStatus("完了")).toBe("完了");
    expect(normalizeStatus("凍結")).toBe("凍結");
  });

  it("trims whitespace", () => {
    expect(normalizeStatus("  未着手  ")).toBe("未着手");
    expect(normalizeStatus("\t完了\n")).toBe("完了");
  });

  it("maps english aliases", () => {
    expect(normalizeStatus("todo")).toBe("未着手");
    expect(normalizeStatus("TODO")).toBe("未着手");
    expect(normalizeStatus("In Progress")).toBe("進行中");
    expect(normalizeStatus("in_progress")).toBe("進行中");
    expect(normalizeStatus("review")).toBe("確認待ち");
    expect(normalizeStatus("done")).toBe("完了");
    expect(normalizeStatus("Completed")).toBe("完了");
    expect(normalizeStatus("frozen")).toBe("凍結");
  });

  it("returns null for unknown status", () => {
    expect(normalizeStatus("kaboom")).toBeNull();
    expect(normalizeStatus("")).toBeNull();
  });
});

describe("normalizeTag", () => {
  it("trims, NFC normalizes, lowercases", () => {
    expect(normalizeTag("  Tag  ")).toBe("tag");
    expect(normalizeTag("ABC")).toBe("abc");
  });

  it("preserves japanese characters with NFC", () => {
    expect(normalizeTag("ブログ")).toBe("ブログ");
    expect(normalizeTag("素材")).toBe("素材");
  });
});

describe("statusHasVariance", () => {
  it("returns variant=false for canonical exact match", () => {
    const r = statusHasVariance("未着手");
    expect(r.variant).toBe(false);
    expect(r.canonical).toBe("未着手");
  });

  it("returns variant=true for whitespace variant", () => {
    const r = statusHasVariance("未着手 ");
    expect(r.variant).toBe(true);
    expect(r.canonical).toBe("未着手");
  });

  it("returns variant=true for alias", () => {
    const r = statusHasVariance("done");
    expect(r.variant).toBe(true);
    expect(r.canonical).toBe("完了");
  });

  it("returns variant=true with null canonical for unknown", () => {
    const r = statusHasVariance("xxx");
    expect(r.variant).toBe(true);
    expect(r.canonical).toBeNull();
  });
});
