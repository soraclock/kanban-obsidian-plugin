import type { Task, Status } from "./Task";
import { STATUS_VALUES } from "./TaskSchema";

/**
 * Phase 6: 同じ status 内の order を 1.0, 2.0, 3.0... に振り直すための計画を作る純関数。
 *
 * 仕様:
 * - 各 status 列を order 昇順でソート
 * - 1 から始まる連番に振り直し
 * - 元の order と一致する task は plan に含めない (no-op 書き込みを避ける)
 * - 戻り値は status ごとの「書き換え対象」リスト
 */
export interface CompactionPlanEntry {
  filePath: string;
  expectedHash: string;
  oldOrder: number | undefined;
  newOrder: number;
  status: Status;
}

export function planRecompactOrders(allTasks: Task[]): CompactionPlanEntry[] {
  const plan: CompactionPlanEntry[] = [];
  for (const status of STATUS_VALUES) {
    const inColumn = allTasks
      .filter((t) => t.status === status)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (let i = 0; i < inColumn.length; i++) {
      const t = inColumn[i]!;
      const newOrder = i + 1;
      if (t.order === newOrder) continue;
      plan.push({
        filePath: t.filePath,
        expectedHash: t.contentHash,
        oldOrder: t.order,
        newOrder,
        status,
      });
    }
  }
  return plan;
}
