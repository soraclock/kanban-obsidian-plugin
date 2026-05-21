import * as React from "react";
import { useMemo, useState } from "react";
import { useBoardStore } from "../../store/boardStore";
import { filterTasks } from "../../data/TaskFilter";
import { DetailPane } from "./DetailPane";
import type { Task } from "../../data/Task";
import type { PluginContext } from "../PluginContext";
import { parseRecurrence, expandRecurrencesInMonth } from "../../data/Recurrence";

/**
 * Phase 10 (P1): カレンダービュー。
 *
 * - 月別グリッド（日曜始まり、7 列）
 * - 各セルに due がその日のタスクをチップで表示
 * - 完了 / 凍結はデフォルト非表示（FilterBar でステータス指定可）
 * - チップクリックで DetailPane を開く
 * - 月送り/戻し、今日に戻る、月内合計表示
 */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function todayYmd(): string {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

interface ChipEntry {
  task: Task;
  /** v0.6.0: status=定期 の親の recurrence から仮想展開された予定日チップ。
   *  実ファイルではなく親 task を参照、見た目で実チップと区別する。 */
  isRecurringPreview: boolean;
}

interface MonthGrid {
  year: number;
  month: number; // 1-12
  // 6 週 x 7 = 42 セル。先頭の前月分・末尾の翌月分も含めて格子を埋める。
  cells: { y: number; m: number; d: number; ymd: string; inMonth: boolean }[];
}

function buildMonthGrid(year: number, month: number): MonthGrid {
  const first = new Date(year, month - 1, 1);
  const firstWeekday = first.getDay(); // 0=日
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells: MonthGrid["cells"] = [];
  // 先頭の前月分埋め
  const prevMonthDays = new Date(year, month - 1, 0).getDate();
  for (let i = 0; i < firstWeekday; i++) {
    const d = prevMonthDays - firstWeekday + 1 + i;
    const py = month === 1 ? year - 1 : year;
    const pm = month === 1 ? 12 : month - 1;
    cells.push({ y: py, m: pm, d, ymd: ymd(py, pm, d), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y: year, m: month, d, ymd: ymd(year, month, d), inMonth: true });
  }
  // 末尾を 42 になるまで翌月で埋める
  let nd = 1;
  while (cells.length < 42) {
    const ny = month === 12 ? year + 1 : year;
    const nm = month === 12 ? 1 : month + 1;
    cells.push({ y: ny, m: nm, d: nd, ymd: ymd(ny, nm, nd), inMonth: false });
    nd++;
  }
  return { year, month, cells };
}

export function CalendarView({ ctx }: { ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const filter = useBoardStore((s) => s.filter);
  const openDetail = useBoardStore((s) => s.openDetail);

  const today = todayYmd();
  const [cursor, setCursor] = useState<{ year: number; month: number }>(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  const grid = useMemo(() => buildMonthGrid(cursor.year, cursor.month), [cursor]);

  // FilterBar の filter を反映、ただし statuses が空のときはデフォルトで「完了/凍結を除外」する
  const visibleTasks = useMemo(() => {
    const filtered = filterTasks(tasks, filter);
    if (filter.statuses.length > 0) return filtered;
    return filtered.filter((t) => t.status !== "完了" && t.status !== "凍結");
  }, [tasks, filter]);

  // due ベースで日付ごとに分配。v0.6.0: status=定期 + recurrence のタスクは
  // recurrence パターンから表示中の月の予定日を仮想展開して追加 (isRecurringPreview)。
  // 仮想チップは実ファイルでなく親タスクを参照する。
  const byDate = useMemo(() => {
    const map = new Map<string, ChipEntry[]>();
    for (const t of visibleTasks) {
      if (t.due) {
        const arr = map.get(t.due) ?? [];
        arr.push({ task: t, isRecurringPreview: false });
        map.set(t.due, arr);
      }
      // 定期タスクの recurrence を月内に仮想展開
      if (t.status === "定期" && t.recurrence) {
        const rec = parseRecurrence(t.recurrence);
        if (!rec) continue;
        const base = t.due ? new Date(t.due + "T00:00:00") : null;
        const dates = expandRecurrencesInMonth(rec, base, cursor.year, cursor.month - 1);
        for (const d of dates) {
          // 親の due 自身は実チップとして既に出ているので、ここでは重複して出さない
          if (d === t.due) continue;
          const arr = map.get(d) ?? [];
          arr.push({ task: t, isRecurringPreview: true });
          map.set(d, arr);
        }
      }
    }
    // 優先度 P0→P3、その中で 実チップ → 仮想チップ、order 昇順
    const rank: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const pa = rank[a.task.priority] ?? 9;
        const pb = rank[b.task.priority] ?? 9;
        if (pa !== pb) return pa - pb;
        if (a.isRecurringPreview !== b.isRecurringPreview) {
          return a.isRecurringPreview ? 1 : -1;
        }
        return (a.task.order ?? 0) - (b.task.order ?? 0);
      });
    }
    return map;
  }, [visibleTasks, cursor]);

  // v0.6.0: 月内合計は実チップのみカウント。仮想予定チップ (定期の展開) は除外して、
  // ユーザーが「期限あり N 件」の数字を実タスクの感覚で読めるようにする。
  const monthTotal = Array.from(byDate.entries())
    .filter(([k]) => k.startsWith(`${cursor.year}-${String(cursor.month).padStart(2, "0")}`))
    .reduce((n, [, arr]) => n + arr.filter((e) => !e.isRecurringPreview).length, 0);

  const goPrev = (): void => {
    const m = cursor.month === 1 ? 12 : cursor.month - 1;
    const y = cursor.month === 1 ? cursor.year - 1 : cursor.year;
    setCursor({ year: y, month: m });
  };
  const goNext = (): void => {
    const m = cursor.month === 12 ? 1 : cursor.month + 1;
    const y = cursor.month === 12 ? cursor.year + 1 : cursor.year;
    setCursor({ year: y, month: m });
  };
  const goToday = (): void => {
    const d = new Date();
    setCursor({ year: d.getFullYear(), month: d.getMonth() + 1 });
  };

  return (
    <div className="kanban-calendar-layout">
      <div className="kanban-calendar-view">
        <header className="kanban-calendar-header">
          <button type="button" className="kanban-calendar-nav" onClick={goPrev} aria-label="前の月">
            ‹
          </button>
          <h3 className="kanban-calendar-title">
            {cursor.year}年 {cursor.month}月
            <span className="kanban-calendar-total">期限あり {monthTotal} 件</span>
          </h3>
          <button type="button" className="kanban-calendar-nav" onClick={goNext} aria-label="次の月">
            ›
          </button>
          <button type="button" className="kanban-calendar-today" onClick={goToday}>
            今日へ
          </button>
        </header>
        <div className="kanban-calendar-weekday-row">
          {WEEKDAY_LABELS.map((w, i) => (
            <div
              key={w}
              className={`kanban-calendar-weekday ${i === 0 ? "is-sun" : ""} ${i === 6 ? "is-sat" : ""}`}
            >
              {w}
            </div>
          ))}
        </div>
        <div className="kanban-calendar-grid">
          {grid.cells.map((cell, i) => {
            const items = byDate.get(cell.ymd) ?? [];
            const isToday = cell.ymd === today;
            const isPast = cell.ymd < today;
            const weekday = i % 7;
            return (
              <div
                key={cell.ymd}
                className={`kanban-calendar-cell ${cell.inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""} ${isPast ? "is-past" : ""} ${weekday === 0 ? "is-sun" : ""} ${weekday === 6 ? "is-sat" : ""}`}
              >
                <div className="kanban-calendar-cell-head">
                  <span className="kanban-calendar-cell-day">{cell.d}</span>
                  {items.length > 0 && (
                    <span className="kanban-calendar-cell-count">{items.length}</span>
                  )}
                </div>
                <div className="kanban-calendar-cell-body">
                  {items.slice(0, 4).map((entry, idx) => {
                    const t = entry.task;
                    const preview = entry.isRecurringPreview;
                    return (
                      <button
                        key={`${t.id}-${idx}-${preview ? "p" : "r"}`}
                        type="button"
                        className={`kanban-calendar-chip kanban-priority-${t.priority.toLowerCase()} ${preview ? "is-recurring-preview" : ""}`}
                        onClick={() => openDetail(t.filePath)}
                        title={
                          preview
                            ? `${t.id} ${t.title}（定期の予定）`
                            : `${t.id} ${t.title}`
                        }
                      >
                        {preview && (
                          <span className="kanban-calendar-chip-recurring-mark">定</span>
                        )}
                        <span className="kanban-calendar-chip-prio">{t.priority}</span>
                        <span className="kanban-calendar-chip-title">{t.title}</span>
                      </button>
                    );
                  })}
                  {items.length > 4 && (
                    <span className="kanban-calendar-chip-more">+{items.length - 4}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <DetailPane ctx={ctx} />
    </div>
  );
}
