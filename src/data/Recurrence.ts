/**
 * Phase 7 定期タスク。frontmatter `recurrence` の書式と、次回 due 日付の計算。
 *
 * サポート書式 (全て小文字):
 * - `daily`              : 毎日
 * - `weekly:mon`         : 毎週 (曜日: mon|tue|wed|thu|fri|sat|sun)
 * - `monthly:15`         : 毎月 (日付: 1..31)
 * - `monthly:lastday`    : 毎月末日
 * - `every:7d`           : N 日ごと (N: 1..)
 *
 * 完了に遷移したタスクに recurrence があれば、main.ts 側で次回 due を計算して
 * 新規 K-NNNN ファイルを作る (RecurrenceSpawner)。
 */
export type Recurrence =
  | { kind: "daily" }
  | { kind: "weekly"; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 } // 0=日 1=月 ... 6=土
  | { kind: "monthlyDay"; day: number } // 1..31
  | { kind: "monthlyLast" }
  | { kind: "every"; days: number };

const WEEKDAY_MAP: Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function parseRecurrence(spec: string): Recurrence | null {
  const s = spec.trim().toLowerCase();
  if (s === "daily") return { kind: "daily" };
  const wm = s.match(/^weekly:(sun|mon|tue|wed|thu|fri|sat)$/);
  if (wm) return { kind: "weekly", weekday: WEEKDAY_MAP[wm[1]!]! };
  if (s === "monthly:lastday") return { kind: "monthlyLast" };
  const dm = s.match(/^monthly:(\d{1,2})$/);
  if (dm) {
    const d = Number(dm[1]);
    if (d >= 1 && d <= 31) return { kind: "monthlyDay", day: d };
  }
  const em = s.match(/^every:(\d+)d$/);
  if (em) {
    const n = Number(em[1]);
    if (n >= 1) return { kind: "every", days: n };
  }
  return null;
}

export function isValidRecurrenceSpec(spec: string): boolean {
  return parseRecurrence(spec) !== null;
}

/**
 * 基準日 (= 直前の due または完了日) から次回の due 日付を計算する。
 * 戻り値は "YYYY-MM-DD"。
 *
 * 仕様:
 * - daily: base + 1 日
 * - weekly:曜日: base より後で初めてその曜日になる日 (同曜日は +7 日)
 * - monthly:N: base を含めず翌月以降の N 日 (N が当月にあれば当月、過ぎていれば翌月)
 * - monthly:lastday: base を含めず翌月以降の月末
 * - every:Nd: base + N 日
 */
export function nextDueDate(recurrence: Recurrence, base: Date): string {
  const baseY = base.getFullYear();
  const baseM = base.getMonth();
  const baseD = base.getDate();
  switch (recurrence.kind) {
    case "daily":
      return ymd(new Date(baseY, baseM, baseD + 1));
    case "weekly": {
      const baseDow = base.getDay();
      let diff = recurrence.weekday - baseDow;
      if (diff <= 0) diff += 7;
      return ymd(new Date(baseY, baseM, baseD + diff));
    }
    case "monthlyDay": {
      // 当月の指定日がまだ未来なら当月、それ以外は翌月以降。月末を超える日付は当月末に丸める。
      const candidateThisMonth = clampDayToMonth(baseY, baseM, recurrence.day);
      if (candidateThisMonth > baseD) {
        return ymd(new Date(baseY, baseM, candidateThisMonth));
      }
      const next = addMonths(baseY, baseM, 1);
      const day = clampDayToMonth(next.y, next.m, recurrence.day);
      return ymd(new Date(next.y, next.m, day));
    }
    case "monthlyLast": {
      const thisLast = lastDayOfMonth(baseY, baseM);
      if (thisLast > baseD) {
        return ymd(new Date(baseY, baseM, thisLast));
      }
      const next = addMonths(baseY, baseM, 1);
      return ymd(new Date(next.y, next.m, lastDayOfMonth(next.y, next.m)));
    }
    case "every":
      return ymd(new Date(baseY, baseM, baseD + recurrence.days));
  }
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

function clampDayToMonth(y: number, m: number, day: number): number {
  return Math.min(day, lastDayOfMonth(y, m));
}

function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const total = y * 12 + m + n;
  return { y: Math.floor(total / 12), m: total % 12 };
}
