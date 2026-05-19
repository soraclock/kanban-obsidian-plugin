import { describe, it, expect } from "vitest";
import { sha256, ConflictError } from "../../src/data/ContentHash";

describe("sha256", () => {
  it("produces stable hex digest for same input", () => {
    const a = sha256("hello");
    const b = sha256("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different inputs", () => {
    expect(sha256("hello")).not.toBe(sha256("hello!"));
  });

  it("handles utf-8 (japanese) consistently", () => {
    const a = sha256("アワード2026素材");
    const b = sha256("アワード2026素材");
    expect(a).toBe(b);
  });
});

describe("ConflictError", () => {
  it("carries filePath / expectedHash / actualHash", () => {
    const e = new ConflictError("mismatch", "tasks/K-0001.md", "abc", "def");
    expect(e.name).toBe("ConflictError");
    expect(e.filePath).toBe("tasks/K-0001.md");
    expect(e.expectedHash).toBe("abc");
    expect(e.actualHash).toBe("def");
    expect(e instanceof Error).toBe(true);
  });
});
