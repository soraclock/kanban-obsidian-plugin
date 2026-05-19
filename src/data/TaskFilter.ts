import type { Task } from "./Task";
import type { BoardFilter, DueFilter } from "../store/boardStore";

/**
 * Phase 6: タスク配列にフィルタ + 検索を適用する純関数。
 * Board.tsx で tasks を Column に渡す前に呼ぶ。テスト容易性のため純関数に分離。
 *
 * 仕様:
 * - priorities: 空配列 = 全部、非空 = OR 含む
 * - statuses (Phase 9): 空配列 = 全部、非空 = OR 含む
 * - tags: 空配列 = 全部、非空 = AND (全タグ含む)
 * - due: today / thisWeek / overdue / noDue / null(全部)
 * - searchQuery: 空 = 全部、非空 = タイトル部分一致 (大文字小文字無視、Unicode 対応)
 */
export function filterTasks(tasks: Task[], filter: BoardFilter, today: Date = new Date()): Task[] {
  const ymdToday = ymd(today);
  // thisWeek の範囲: today <= due <= today+7 (両端 inclusive, 8 日分)
  const ymdWeekEnd = ymd(addDays(today, 7));
  const query = filter.searchQuery.trim().toLocaleLowerCase();
  return tasks.filter((t) => {
    if (filter.priorities.length > 0 && !filter.priorities.includes(t.priority)) return false;
    if (filter.statuses.length > 0 && !filter.statuses.includes(t.status)) return false;
    if (filter.tags.length > 0) {
      // AND: 全タグを含む必要
      for (const wantTag of filter.tags) {
        if (!t.tags.includes(wantTag)) return false;
      }
    }
    if (filter.due !== null && !matchDueFilter(t.due ?? null, filter.due, ymdToday, ymdWeekEnd)) {
      return false;
    }
    if (query !== "" && !t.title.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}

/** vault から見える全タスクの tags 一覧 (重複除去, 昇順)。FilterBar dropdown 用 */
export function collectAllTags(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) for (const tag of t.tags) set.add(tag);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function matchDueFilter(
  due: string | null,
  filter: Exclude<DueFilter, null>,
  ymdToday: string,
  ymdWeekEnd: string,
): boolean {
  if (filter === "noDue") return due === null;
  if (due === null) return false;
  if (filter === "today") return due === ymdToday;
  if (filter === "thisWeek") return due >= ymdToday && due <= ymdWeekEnd;
  if (filter === "overdue") return due < ymdToday;
  return true;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(d.getDate() + n);
  return next;
}
