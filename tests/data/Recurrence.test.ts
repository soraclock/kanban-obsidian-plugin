import { describe, it, expect } from "vitest";
import {
  parseRecurrence,
  isValidRecurrenceSpec,
  nextDueDate,
  expandRecurrencesInMonth,
  recurrenceLabel,
} from "../../src/data/Recurrence";

describe("parseRecurrence", () => {
  it("accepts daily", () => {
    expect(parseRecurrence("daily")).toEqual({ kind: "daily" });
  });
  it("accepts weekly:曜日 (mon..sun)", () => {
    expect(parseRecurrence("weekly:mon")).toEqual({ kind: "weekly", weekday: 1 });
    expect(parseRecurrence("weekly:sun")).toEqual({ kind: "weekly", weekday: 0 });
    expect(parseRecurrence("weekly:sat")).toEqual({ kind: "weekly", weekday: 6 });
  });
  it("accepts monthly:N (1..31)", () => {
    expect(parseRecurrence("monthly:1")).toEqual({ kind: "monthlyDay", day: 1 });
    expect(parseRecurrence("monthly:15")).toEqual({ kind: "monthlyDay", day: 15 });
    expect(parseRecurrence("monthly:31")).toEqual({ kind: "monthlyDay", day: 31 });
  });
  it("accepts monthly:lastday", () => {
    expect(parseRecurrence("monthly:lastday")).toEqual({ kind: "monthlyLast" });
  });
  it("accepts every:Nd", () => {
    expect(parseRecurrence("every:7d")).toEqual({ kind: "every", days: 7 });
    expect(parseRecurrence("every:14d")).toEqual({ kind: "every", days: 14 });
  });
  it("is case-insensitive and trims whitespace", () => {
    expect(parseRecurrence("  WEEKLY:Mon  ")).toEqual({ kind: "weekly", weekday: 1 });
  });
  it("rejects invalid", () => {
    expect(parseRecurrence("")).toBeNull();
    expect(parseRecurrence("yearly:1-1")).toBeNull();
    expect(parseRecurrence("weekly:xyz")).toBeNull();
    expect(parseRecurrence("monthly:32")).toBeNull();
    expect(parseRecurrence("monthly:0")).toBeNull();
    expect(parseRecurrence("every:0d")).toBeNull();
    expect(parseRecurrence("every:7")).toBeNull();
  });
});

describe("isValidRecurrenceSpec", () => {
  it("mirrors parseRecurrence non-null", () => {
    expect(isValidRecurrenceSpec("daily")).toBe(true);
    expect(isValidRecurrenceSpec("monthly:lastday")).toBe(true);
    expect(isValidRecurrenceSpec("invalid")).toBe(false);
  });
});

describe("nextDueDate", () => {
  describe("daily", () => {
    it("returns base + 1 day", () => {
      // 2026-05-12 (火) → 2026-05-13
      expect(nextDueDate({ kind: "daily" }, new Date(2026, 4, 12))).toBe("2026-05-13");
    });
    it("handles month boundary", () => {
      // 2026-05-31 → 2026-06-01
      expect(nextDueDate({ kind: "daily" }, new Date(2026, 4, 31))).toBe("2026-06-01");
    });
  });

  describe("weekly", () => {
    it("next occurrence of weekday", () => {
      // 2026-05-12 火 (weekday=2)、weekly:fri(5) → 2026-05-15 (金)
      expect(nextDueDate({ kind: "weekly", weekday: 5 }, new Date(2026, 4, 12))).toBe(
        "2026-05-15",
      );
    });
    it("same weekday returns +7 days (not 0)", () => {
      // 2026-05-12 火 (weekday=2)、weekly:tue → 2026-05-19
      expect(nextDueDate({ kind: "weekly", weekday: 2 }, new Date(2026, 4, 12))).toBe(
        "2026-05-19",
      );
    });
    it("wraps around week", () => {
      // 2026-05-15 金 (weekday=5)、weekly:mon(1) → 2026-05-18 (月)
      expect(nextDueDate({ kind: "weekly", weekday: 1 }, new Date(2026, 4, 15))).toBe(
        "2026-05-18",
      );
    });
  });

  describe("monthlyDay", () => {
    it("returns this month if day is still future", () => {
      // 2026-05-10、monthly:20 → 2026-05-20
      expect(nextDueDate({ kind: "monthlyDay", day: 20 }, new Date(2026, 4, 10))).toBe(
        "2026-05-20",
      );
    });
    it("returns next month if day has passed", () => {
      // 2026-05-25、monthly:10 → 2026-06-10
      expect(nextDueDate({ kind: "monthlyDay", day: 10 }, new Date(2026, 4, 25))).toBe(
        "2026-06-10",
      );
    });
    it("returns next month if same day (= today)", () => {
      // 2026-05-15、monthly:15 → 2026-06-15
      expect(nextDueDate({ kind: "monthlyDay", day: 15 }, new Date(2026, 4, 15))).toBe(
        "2026-06-15",
      );
    });
    it("clamps day to month length (Feb 30 → Feb 28/29)", () => {
      // 2026-01-01 in non-leap year → Feb 28 ではなく day=30 を当月に reserveしようとして上書き
      // 1/1 で monthly:30 → 1月は 30 日があるので 2026-01-30
      expect(nextDueDate({ kind: "monthlyDay", day: 30 }, new Date(2026, 0, 1))).toBe(
        "2026-01-30",
      );
      // 2/1 で monthly:30 → 2月は 28 日まで → 2026-02-28 に clamp
      expect(nextDueDate({ kind: "monthlyDay", day: 30 }, new Date(2026, 1, 1))).toBe(
        "2026-02-28",
      );
    });
    it("monthly:31 in February → clamps to month end", () => {
      // 2026-01-31 (土) → 2026-02-28 (土)
      expect(nextDueDate({ kind: "monthlyDay", day: 31 }, new Date(2026, 0, 31))).toBe(
        "2026-02-28",
      );
      // 2026-02-15 → 2026-02-28 (今月の最終日)
      expect(nextDueDate({ kind: "monthlyDay", day: 31 }, new Date(2026, 1, 15))).toBe(
        "2026-02-28",
      );
    });
  });

  describe("monthlyLast", () => {
    it("returns this month last day if not yet passed", () => {
      // 2026-05-15、monthly:lastday → 2026-05-31
      expect(nextDueDate({ kind: "monthlyLast" }, new Date(2026, 4, 15))).toBe("2026-05-31");
    });
    it("returns next month last day if at month end", () => {
      // 2026-05-31、monthly:lastday → 2026-06-30
      expect(nextDueDate({ kind: "monthlyLast" }, new Date(2026, 4, 31))).toBe("2026-06-30");
    });
  });

  describe("every:Nd", () => {
    it("base + N days", () => {
      expect(nextDueDate({ kind: "every", days: 7 }, new Date(2026, 4, 12))).toBe("2026-05-19");
      expect(nextDueDate({ kind: "every", days: 14 }, new Date(2026, 4, 12))).toBe(
        "2026-05-26",
      );
    });
  });
});

describe("expandRecurrencesInMonth", () => {
  it("daily: 月内の全日を返す (2026-05 は 31 日)", () => {
    const result = expandRecurrencesInMonth({ kind: "daily" }, null, 2026, 4); // month 4 = 5月
    expect(result).toHaveLength(31);
    expect(result[0]).toBe("2026-05-01");
    expect(result[30]).toBe("2026-05-31");
  });

  it("weekly:mon: 2026-05 内の月曜を全部返す", () => {
    const result = expandRecurrencesInMonth(
      { kind: "weekly", weekday: 1 },
      null,
      2026,
      4,
    );
    // 2026年5月の月曜は 4, 11, 18, 25
    expect(result).toEqual(["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"]);
  });

  it("monthlyDay: 指定日が月内に存在", () => {
    expect(expandRecurrencesInMonth({ kind: "monthlyDay", day: 15 }, null, 2026, 4)).toEqual([
      "2026-05-15",
    ]);
  });

  it("monthlyDay: 月末超えは月末に丸める (2月に31日指定 → 2月28日)", () => {
    expect(
      expandRecurrencesInMonth({ kind: "monthlyDay", day: 31 }, null, 2026, 1), // month 1 = 2月
    ).toEqual(["2026-02-28"]);
  });

  it("monthlyLast: 各月の月末", () => {
    expect(expandRecurrencesInMonth({ kind: "monthlyLast" }, null, 2026, 4)).toEqual([
      "2026-05-31",
    ]);
    expect(expandRecurrencesInMonth({ kind: "monthlyLast" }, null, 2026, 1)).toEqual([
      "2026-02-28",
    ]);
  });

  it("every:Nd: base から N 日ごとに月内の日付を集める", () => {
    // base=2026-05-04, every:7d → 2026-05 内: 4, 11, 18, 25
    const result = expandRecurrencesInMonth(
      { kind: "every", days: 7 },
      new Date(2026, 4, 4),
      2026,
      4,
    );
    expect(result).toEqual(["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25"]);
  });

  it("every:Nd: base が翌月以降でも未来月で正しく展開", () => {
    // base=2026-04-30, every:5d → 2026-05 内: 5, 10, 15, 20, 25, 30
    const result = expandRecurrencesInMonth(
      { kind: "every", days: 5 },
      new Date(2026, 3, 30),
      2026,
      4,
    );
    expect(result).toEqual([
      "2026-05-05",
      "2026-05-10",
      "2026-05-15",
      "2026-05-20",
      "2026-05-25",
      "2026-05-30",
    ]);
  });

  it("every:Nd: base が null なら空配列 (基準なしでは計算不能)", () => {
    expect(
      expandRecurrencesInMonth({ kind: "every", days: 7 }, null, 2026, 4),
    ).toEqual([]);
  });
});

describe("recurrenceLabel", () => {
  it("各書式を人間語に変換", () => {
    expect(recurrenceLabel("daily")).toBe("毎日");
    expect(recurrenceLabel("weekly:mon")).toBe("毎週月曜");
    expect(recurrenceLabel("weekly:fri")).toBe("毎週金曜");
    expect(recurrenceLabel("monthly:15")).toBe("毎月15日");
    expect(recurrenceLabel("monthly:lastday")).toBe("毎月末日");
    expect(recurrenceLabel("every:7d")).toBe("7日ごと");
  });

  it("null / 不正書式は null", () => {
    expect(recurrenceLabel(null)).toBeNull();
    expect(recurrenceLabel(undefined)).toBeNull();
    expect(recurrenceLabel("")).toBeNull();
    expect(recurrenceLabel("invalid-spec")).toBeNull();
  });
});
