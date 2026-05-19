import * as React from "react";
import { useMemo } from "react";
import { useBoardStore } from "../../store/boardStore";
import { DetailPane } from "./DetailPane";
import type { Task } from "../../data/Task";
import type { PluginContext } from "../PluginContext";

/**
 * Phase 10 (P2): ダッシュボード / 統計ビュー。
 *
 * 集計:
 * - KPI: 全件 / アクティブ / 完了 / 凍結 / 期限超過 / 今日期限
 * - 過去 8 週の完了数推移（completedAt → updated fallback）
 * - 優先度別 active 件数（P0/P1/P2/P3）
 * - 滞留タスク TOP 5（created 古い順、active のみ）
 * - 平均リードタイム（created → completedAt or updated）
 *
 * 既存データだけで集計（journal は読まない）。
 */
const PRIORITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekMonday(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const w = out.getDay();
  const diff = w === 0 ? -6 : 1 - w;
  out.setDate(out.getDate() + diff);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function completionDateYmd(t: Task): string | null {
  if (t.status !== "完了") return null;
  if (typeof t.completedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.completedAt)) {
    return t.completedAt;
  }
  if (typeof t.updated === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.updated)) {
    return t.updated;
  }
  return null;
}

function diffDaysYmd(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

export function StatsView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const openDetail = useBoardStore((s) => s.openDetail);

  const today = ymd(new Date());

  const stats = useMemo(() => {
    const total = tasks.length;
    let active = 0;
    let done = 0;
    let frozen = 0;
    let overdue = 0;
    let dueToday = 0;
    const priorityCounts: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const t of tasks) {
      if (t.status === "完了") done++;
      else if (t.status === "凍結") frozen++;
      else {
        active++;
        if (t.due) {
          if (t.due < today) overdue++;
          else if (t.due === today) dueToday++;
        }
        if (Object.prototype.hasOwnProperty.call(priorityCounts, t.priority)) {
          priorityCounts[t.priority] = (priorityCounts[t.priority] ?? 0) + 1;
        }
      }
    }

    // 過去 8 週の完了数
    const weekStart = startOfWeekMonday(new Date());
    const weeks: { label: string; count: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const ws = addDays(weekStart, -7 * i);
      const we = addDays(ws, 6);
      const wsYmd = ymd(ws);
      const weYmd = ymd(we);
      let count = 0;
      for (const t of tasks) {
        const cd = completionDateYmd(t);
        if (cd && cd >= wsYmd && cd <= weYmd) count++;
      }
      // ラベルは "M/D" の週始まり
      weeks.push({ label: `${ws.getMonth() + 1}/${ws.getDate()}`, count });
    }

    // 滞留タスク TOP 5 (created が古い active 順、created が無いものは末尾)
    const stalled = tasks
      .filter((t) => t.status !== "完了" && t.status !== "凍結")
      .map((t) => ({
        t,
        ageDays: t.created ? diffDaysYmd(t.created, today) : -1,
      }))
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 5);

    // 平均リードタイム (created → completedAt or updated, 完了タスクのみ)
    const leadTimes: number[] = [];
    for (const t of tasks) {
      if (t.status !== "完了") continue;
      const cd = completionDateYmd(t);
      if (!cd || !t.created) continue;
      const d = diffDaysYmd(t.created, cd);
      if (d >= 0) leadTimes.push(d);
    }
    const avgLeadTime =
      leadTimes.length === 0
        ? null
        : leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;

    return {
      total,
      active,
      done,
      frozen,
      overdue,
      dueToday,
      priorityCounts,
      weeks,
      stalled,
      avgLeadTime,
    };
  }, [tasks, today]);

  // 棒グラフの最大値 (描画用)
  const maxWeek = Math.max(1, ...stats.weeks.map((w) => w.count));

  return (
    <div className="kanban-stats-layout">
      <div className="kanban-stats-view">
        <header className="kanban-subview-header">
          <h2 className="kanban-subview-h2">統計ダッシュボード</h2>
        </header>

        <section className="kanban-stats-section">
          <h3 className="kanban-stats-section-h3">概要</h3>
          <div className="kanban-stats-kpis">
            <Kpi label="全タスク" value={stats.total} />
            <Kpi label="アクティブ" value={stats.active} />
            <Kpi label="完了" value={stats.done} />
            <Kpi label="凍結" value={stats.frozen} />
            <Kpi label="期限超過" value={stats.overdue} tone={stats.overdue > 0 ? "warn" : undefined} />
            <Kpi label="今日期限" value={stats.dueToday} tone={stats.dueToday > 0 ? "accent" : undefined} />
            <Kpi
              label="平均リードタイム"
              value={stats.avgLeadTime === null ? "—" : `${stats.avgLeadTime.toFixed(1)} 日`}
            />
          </div>
        </section>

        <section className="kanban-stats-section">
          <h3 className="kanban-stats-section-h3">過去 8 週の完了数</h3>
          <div className="kanban-stats-bars">
            {stats.weeks.map((w, i) => (
              <div key={i} className="kanban-stats-bar-col">
                <div
                  className="kanban-stats-bar"
                  style={{ height: `${(w.count / maxWeek) * 100}%` }}
                  title={`${w.label} 週: ${w.count} 件`}
                >
                  {w.count > 0 && <span className="kanban-stats-bar-value">{w.count}</span>}
                </div>
                <div className="kanban-stats-bar-label">{w.label}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="kanban-stats-section">
          <h3 className="kanban-stats-section-h3">優先度別 アクティブ件数</h3>
          <div className="kanban-stats-priorities">
            {PRIORITY_ORDER.map((p) => (
              <div
                key={p}
                className={`kanban-stats-priority kanban-priority-${p.toLowerCase()}`}
              >
                <span className="kanban-stats-priority-label">{p}</span>
                <span className="kanban-stats-priority-value">
                  {stats.priorityCounts[p] ?? 0}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="kanban-stats-section">
          <h3 className="kanban-stats-section-h3">滞留タスク TOP 5 (作成からの経過日数)</h3>
          {stats.stalled.length === 0 ? (
            <p className="kanban-subview-empty">アクティブタスクなし</p>
          ) : (
            <div className="kanban-stats-stalled">
              {stats.stalled.map(({ t, ageDays }) => (
                <button
                  key={t.filePath}
                  type="button"
                  className="kanban-stats-stalled-row"
                  onClick={() => openDetail(t.filePath)}
                >
                  <span className="kanban-completed-id">{t.id}</span>
                  <span className="kanban-stats-stalled-title">{t.title}</span>
                  <span
                    className={`kanban-badge kanban-priority-${t.priority.toLowerCase()}`}
                  >
                    {t.priority}
                  </span>
                  <span className="kanban-stats-stalled-age">
                    {ageDays >= 0 ? `${ageDays} 日` : "—"}
                  </span>
                  <span className="kanban-stats-stalled-status">{t.status}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <DetailPane ctx={ctx} />
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: "warn" | "accent" }) {
  return (
    <div className={`kanban-stats-kpi ${tone ? `kanban-stats-kpi-${tone}` : ""}`}>
      <div className="kanban-stats-kpi-value">{value}</div>
      <div className="kanban-stats-kpi-label">{label}</div>
    </div>
  );
}
