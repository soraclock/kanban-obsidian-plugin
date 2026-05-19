import { describe, it, expect } from "vitest";
import { computeInsertOrder } from "../../src/data/orderCalc";
import type { Task, Status } from "../../src/data/Task";

function t(id: string, order: number, status: Status = "未着手"): Task {
  return {
    id,
    title: id,
    status,
    assignee: "x",
    priority: "P1",
    created: "2026-05-10",
    updated: "2026-05-10",
    tags: [],
    order,
    filePath: `tasks/${id}.md`,
    contentHash: "h",
    bodyMarkdown: "",
    subtasks: [],
  };
}

describe("computeInsertOrder", () => {
  it("inserts between two existing cards using midpoint", () => {
    const a = t("a", 1);
    const b = t("b", 2);
    const c = t("c", 3);
    const moved = t("moved", 99);
    // moved を c の前 (b の後) に挿入する
    const newOrder = computeInsertOrder([a, b, c, moved], c, moved.id);
    expect(newOrder).toBeGreaterThan(2);
    expect(newOrder).toBeLessThan(3);
  });

  it("inserts before the first card by halving", () => {
    const a = t("a", 4);
    const b = t("b", 5);
    const moved = t("moved", 99);
    const newOrder = computeInsertOrder([a, b, moved], a, moved.id);
    expect(newOrder).toBeLessThan(4);
    expect(newOrder).toBeGreaterThan(0);
    // 半分の値
    expect(newOrder).toBe(2);
  });

  it("does not collide when repeatedly inserting same target (strictly decreasing toward prev)", () => {
    // a=1, b=2 の間に繰り返し挿入。target=b にするたびに b.order が小さくなり、
    // 挿入位置は a に向かって単調減少する。30 回挿入で値の重複なし。
    const a = t("a", 1);
    let b = t("b", 2);
    const orders: number[] = [];
    for (let i = 0; i < 30; i++) {
      const moved = t(`moved-${i}`, 99);
      const newOrder = computeInsertOrder([a, b, moved], b, moved.id);
      if (orders.length > 0) {
        expect(newOrder).toBeLessThan(orders.at(-1)!);
      }
      expect(newOrder).toBeGreaterThan(a.order!);
      expect(newOrder).toBeLessThan(b.order!);
      orders.push(newOrder);
      b = t("b", newOrder);
    }
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("after: inserts between target and next using midpoint", () => {
    const a = t("a", 1);
    const b = t("b", 2);
    const c = t("c", 3);
    const moved = t("moved", 99);
    // moved を b の "後" に挿入 → b と c の間
    const newOrder = computeInsertOrder([a, b, c, moved], b, moved.id, "after");
    expect(newOrder).toBeGreaterThan(2);
    expect(newOrder).toBeLessThan(3);
    expect(newOrder).toBe(2.5);
  });

  it("after: when target is last, appends with +1.0", () => {
    const a = t("a", 1);
    const b = t("b", 2);
    const moved = t("moved", 99);
    // moved を b の "後" (b が末尾) → b.order + 1.0
    const newOrder = computeInsertOrder([a, b, moved], b, moved.id, "after");
    expect(newOrder).toBe(3);
  });

  it("after / before are inverses around the same target", () => {
    // 5 枚並び (1,2,3,4,5) で 3 の前と後の挿入位置を確認
    const cards = [t("a", 1), t("b", 2), t("c", 3), t("d", 4), t("e", 5)];
    const moved = t("moved", 99);
    const c = cards[2]!;
    const before = computeInsertOrder([...cards, moved], c, moved.id, "before");
    const after = computeInsertOrder([...cards, moved], c, moved.id, "after");
    expect(before).toBeLessThan(c.order!);
    expect(after).toBeGreaterThan(c.order!);
    expect(before).toBe(2.5);
    expect(after).toBe(3.5);
  });

  it("repeated head insertion warns near precision boundary but stays strictly decreasing", () => {
    // 先頭挿入の繰り返し: order が半減し続ける
    let head = t("h", 1);
    for (let i = 0; i < 20; i++) {
      const moved = t(`m-${i}`, 99);
      const newOrder = computeInsertOrder([head, moved], head, moved.id);
      expect(newOrder).toBeLessThan(head.order!);
      expect(newOrder).toBeGreaterThan(0);
      head = t("h", newOrder);
    }
  });
});
