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
});
