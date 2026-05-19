import { describe, it, expect } from "vitest";
import { OperationHistory, type UndoableOp } from "../../src/data/OperationHistory";

function op(filePath: string, statusBefore: "未着手" | "進行中" = "未着手"): UndoableOp {
  return {
    type: "status",
    filePath,
    before: { status: statusBefore },
    after: { status: "完了" },
    afterHash: "h",
    ts: new Date().toISOString(),
  };
}

describe("OperationHistory", () => {
  it("push / pop LIFO", () => {
    const h = new OperationHistory();
    h.push(op("a"));
    h.push(op("b"));
    h.push(op("c"));
    expect(h.size()).toBe(3);
    expect(h.pop()!.filePath).toBe("c");
    expect(h.pop()!.filePath).toBe("b");
    expect(h.pop()!.filePath).toBe("a");
    expect(h.pop()).toBeUndefined();
    expect(h.isEmpty()).toBe(true);
  });

  it("respects maxSize by dropping oldest", () => {
    const h = new OperationHistory(3);
    h.push(op("a"));
    h.push(op("b"));
    h.push(op("c"));
    h.push(op("d"));
    expect(h.size()).toBe(3);
    // oldest "a" was dropped
    expect(h.pop()!.filePath).toBe("d");
    expect(h.pop()!.filePath).toBe("c");
    expect(h.pop()!.filePath).toBe("b");
    expect(h.pop()).toBeUndefined();
  });

  it("peek does not pop", () => {
    const h = new OperationHistory();
    h.push(op("a"));
    expect(h.peek()!.filePath).toBe("a");
    expect(h.size()).toBe(1);
  });

  it("clear empties the stack", () => {
    const h = new OperationHistory();
    h.push(op("a"));
    h.push(op("b"));
    h.clear();
    expect(h.size()).toBe(0);
  });

  it("removeByPath drops entries for given file (review security#Minor)", () => {
    const h = new OperationHistory();
    h.push(op("a"));
    h.push(op("b"));
    h.push(op("a"));
    h.push(op("c"));
    const removed = h.removeByPath("a");
    expect(removed).toBe(2);
    expect(h.size()).toBe(2);
    expect(h.pop()!.filePath).toBe("c");
    expect(h.pop()!.filePath).toBe("b");
  });

  it("removeByPath returns 0 if no match", () => {
    const h = new OperationHistory();
    h.push(op("a"));
    expect(h.removeByPath("z")).toBe(0);
    expect(h.size()).toBe(1);
  });
});
