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

/**
 * v0.6.0: 指定月 (year, month) 内に該当する recurrence の予定日を全部返す。
 *
 * - daily: 月内の全日
 * - weekly: 該当曜日の全日
 * - monthlyDay: 指定日（月末超えは月末に丸め）
 * - monthlyLast: 月末
 * - every:Nd: base 日付から N 日ごとに進めて月内に該当する日（base 未指定なら空）
 *
 * 返り値は YYYY-MM-DD の昇順配列。base はカレンダーで未来予定を表示する目的なので、
 * base が月より前でも未来分を計算する。
 */
export function expandRecurrencesInMonth(
  rec: Recurrence,
  base: Date | null,
  year: number,
  month: number, // 0-11
): string[] {
  const result: string[] = [];
  const lastDate = new Date(year, month + 1, 0).getDate();
  const ymdAt = (d: number): string => ymd(new Date(year, month, d));

  switch (rec.kind) {
    case "daily":
      for (let d = 1; d <= lastDate; d++) result.push(ymdAt(d));
      return result;
    case "weekly":
      for (let d = 1; d <= lastDate; d++) {
        if (new Date(year, month, d).getDay() === rec.weekday) {
          result.push(ymdAt(d));
        }
      }
      return result;
    case "monthlyDay":
      result.push(ymdAt(Math.min(rec.day, lastDate)));
      return result;
    case "monthlyLast":
      result.push(ymdAt(lastDate));
      return result;
    case "every": {
      if (!base) return result;
      // base から N 日ずつ前後に振って、月内の日付を集める。
      // DST 影響を避けるため、日付加算は new Date(y, m, d + n) で行う。
      const monthStart = new Date(year, month, 1);
      let cur = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      // base が月より前なら、month に入るまで進める
      while (cur < monthStart) {
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + rec.days);
      }
      // 月内なら全部 push、月を越えたら終了
      while (cur.getFullYear() === year && cur.getMonth() === month) {
        result.push(ymdAt(cur.getDate()));
        cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + rec.days);
      }
      return result;
    }
  }
}

const WEEKDAY_LABEL_FULL: Record<number, string> = {
  0: "日曜",
  1: "月曜",
  2: "火曜",
  3: "水曜",
  4: "木曜",
  5: "金曜",
  6: "土曜",
};

/**
 * v0.6.0: recurrence 書式を人間語ラベルに変換する。
 * 不正な書式 / null は null を返す（呼び出し側で「表示しない」を選べる）。
 */
export function recurrenceLabel(spec: string | null | undefined): string | null {
  if (!spec) return null;
  const r = parseRecurrence(spec);
  if (!r) return null;
  switch (r.kind) {
    case "daily":
      return "毎日";
    case "weekly":
      return `毎週${WEEKDAY_LABEL_FULL[r.weekday] ?? ""}`;
    case "monthlyDay":
      return `毎月${r.day}日`;
    case "monthlyLast":
      return "毎月末日";
    case "every":
      return `${r.days}日ごと`;
  }
}
