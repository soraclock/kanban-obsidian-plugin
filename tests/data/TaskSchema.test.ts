import { describe, it, expect } from "vitest";
import { TaskFrontmatterSchema } from "../../src/data/TaskSchema";

describe("TaskFrontmatterSchema", () => {
  const baseValid = {
    id: "K-0001",
    title: "test",
    status: "未着手" as const,
    assignee: "花木",
    priority: "P1" as const,
    created: "2026-04-18",
    updated: "2026-04-18",
    tags: [],
  };

  it("accepts canonical string-form frontmatter", () => {
    const result = TaskFrontmatterSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });

  it("accepts Date object for created/updated (js-yaml auto-conversion)", () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...baseValid,
      created: new Date("2026-04-18T00:00:00Z"),
      updated: new Date("2026-04-18T00:00:00Z"),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.created).toBe("2026-04-18");
      expect(result.data.updated).toBe("2026-04-18");
    }
  });

  it("accepts Date for due field", () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...baseValid,
      due: new Date("2026-04-30T00:00:00Z"),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.due).toBe("2026-04-30");
    }
  });

  it("accepts null for due", () => {
    const result = TaskFrontmatterSchema.safeParse({ ...baseValid, due: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.due).toBeNull();
    }
  });

  it("rejects invalid date string", () => {
    const result = TaskFrontmatterSchema.safeParse({ ...baseValid, created: "2026/04/18" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid priority", () => {
    const result = TaskFrontmatterSchema.safeParse({ ...baseValid, priority: "P9" });
    expect(result.success).toBe(false);
  });

  it("preserves passthrough keys for SchemaAudit detection", () => {
    const result = TaskFrontmatterSchema.safeParse({ ...baseValid, foo: "bar" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).foo).toBe("bar");
    }
  });

  // v0.1.5 で追加した ISO 8601 string 受け入れ — 過去バージョンが Date オブジェクトを
  // stringifyYaml で書き戻した遺物（`2026-05-03T00:00:00.000Z` 等）を読み込めるようにする。
  it("accepts ISO 8601 string for created and extracts YYYY-MM-DD prefix", () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...baseValid,
      created: "2026-05-03T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.created).toBe("2026-05-03");
  });

  it("accepts ISO 8601 string with timezone offset for due", () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...baseValid,
      due: "2026-05-30T15:30:00+09:00",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.due).toBe("2026-05-30");
  });

  it("accepts ISO 8601 string for completedAt (nullable date field)", () => {
    const result = TaskFrontmatterSchema.safeParse({
      ...baseValid,
      completedAt: "2026-05-19T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.completedAt).toBe("2026-05-19");
  });

  it("rejects garbage string that does not start with YYYY-MM-DD", () => {
    const result = TaskFrontmatterSchema.safeParse({ ...baseValid, created: "not-a-date" });
    expect(result.success).toBe(false);
  });
});
