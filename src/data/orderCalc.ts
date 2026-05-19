import type { Task, Status } from "./Task";

/**
 * fractional indexing の精度限界。これを下回ると同列を 1.0, 2.0, 3.0... に振り直すべき。
 * (review#Major: 約 52 回の同位置挿入で IEEE 754 の精度に到達する問題)
 * 現状は warn のみ。完全な renumber は Phase 6 で manual command として提供予定。
 */
export const MIN_ORDER_GAP = 1e-9;

/** 列末尾追加 (列間 D&D で使う) */
export function computeAppendOrder(allTasks: Task[], status: Status): number {
  const inColumn = allTasks.filter((t) => t.status === status);
  if (inColumn.length === 0) return 1.0;
  const max = Math.max(...inColumn.map((t) => t.order ?? 0));
  return max + 1.0;
}

/**
 * target カードの直前 (before) または直後 (after) に挿入する order を返す。
 * position は handleDragEnd 側で pointer の y 位置で判定する (上半分 = before / 下半分 = after)。
 *
 * - before:
 *   - target が先頭 → 既存最小値の半分
 *   - 中間 → (prev + cur) / 2
 * - after:
 *   - target が末尾 → cur + 1.0
 *   - 中間 → (cur + next) / 2
 *
 * 精度限界に達したら warn 出力 (Phase 6 で renumber コマンド提供予定)。
 */
export function computeInsertOrder(
  allTasks: Task[],
  target: Task,
  activeTaskId: string,
  position: "before" | "after" = "before",
): number {
  const inColumn = allTasks
    .filter((t) => t.status === target.status && t.id !== activeTaskId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const idx = inColumn.findIndex((t) => t.id === target.id);
  const cur = target.order ?? Math.max(idx + 1, 1);

  if (position === "before") {
    if (idx <= 0) {
      if (cur > MIN_ORDER_GAP * 2) return cur / 2;
      console.warn("[kanban] order space exhausted at head, renumber needed");
      return cur - 1;
    }
    const prev = inColumn[idx - 1]!.order ?? idx;
    const newOrder = (prev + cur) / 2;
    if (newOrder - prev < MIN_ORDER_GAP || cur - newOrder < MIN_ORDER_GAP) {
      console.warn(
        `[kanban] fractional indexing precision low (gap < ${MIN_ORDER_GAP}). renumber recommended.`,
      );
    }
    return newOrder;
  }

  // after
  if (idx >= inColumn.length - 1) {
    // 末尾の後 → +1.0
    return cur + 1.0;
  }
  const next = inColumn[idx + 1]!.order ?? idx + 2;
  const newOrder = (cur + next) / 2;
  if (newOrder - cur < MIN_ORDER_GAP || next - newOrder < MIN_ORDER_GAP) {
    console.warn(
      `[kanban] fractional indexing precision low (gap < ${MIN_ORDER_GAP}). renumber recommended.`,
    );
  }
  return newOrder;
}
