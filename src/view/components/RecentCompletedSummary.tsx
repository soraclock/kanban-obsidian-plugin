import * as React from "react";
import type { Task } from "../../data/Task";
import { useBoardStore } from "../../store/boardStore";

/**
 * Phase 8: メインボード上部に「直近完了」のサマリ1行を出す。
 * 完了タスクをサブビューに分離しても達成感が消えないよう、Linear / Things3 が採用している
 * 「今日 / 今週 完了 N件」表示をボード本体に残す。
 *
 * 集計キー:
 * - completedAt があればそれを優先 (Phase 4 で導入したリッチメタ)
 * - 無ければ updated にフォールバック (既存タスクは completedAt 未記入)
 * - status=完了 のもののみ対象
 *
 * 期間判定:
 * - 今日: ローカルタイムゾーンで YYYY-MM-DD が今日と一致
 * - 今週: 月曜起点で過去 7 日 (月曜 0:00:00 以降)
 */
function startOfThisWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // getDay: 0=日, 1=月, ..., 6=土 → 月曜始まりへ補正
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d;
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function completionDateYmd(t: Task): string | null {
  const c = t.completedAt;
  if (typeof c === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  const u = t.updated;
  if (typeof u === "string" && /^\d{4}-\d{2}-\d{2}$/.test(u)) return u;
  return null;
}

export function RecentCompletedSummary({ tasks }: { tasks: Task[] }) {
  const setCurrentView = useBoardStore((s) => s.setCurrentView);

  const { todayCount, weekCount } = React.useMemo(() => {
    const today = todayYmd();
    const weekStart = startOfThisWeek();
    let t = 0;
    let w = 0;
    for (const task of tasks) {
      if (task.status !== "完了") continue;
      const ymd = completionDateYmd(task);
      if (!ymd) continue;
      if (ymd === today) t++;
      // 週: ymd を Date 化して weekStart 以上か判定
      const dt = new Date(`${ymd}T00:00:00`);
      if (!isNaN(dt.getTime()) && dt.getTime() >= weekStart.getTime()) w++;
    }
    return { todayCount: t, weekCount: w };
  }, [tasks]);

  if (todayCount === 0 && weekCount === 0) return null;

  return (
    <div className="kanban-recent-completed" role="status" aria-live="polite">
      <span className="kanban-recent-completed-text">
        今日 <strong>{todayCount}</strong> 件 / 今週 <strong>{weekCount}</strong> 件 完了
      </span>
      <button
        type="button"
        className="kanban-recent-completed-link"
        onClick={() => setCurrentView("completed")}
        aria-label="完了タブを開く"
      >
        完了タブへ →
      </button>
    </div>
  );
}
