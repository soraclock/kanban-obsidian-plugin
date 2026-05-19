import { describe, it, expect } from "vitest";
import { threeWayMerge } from "../../src/view/components/DetailPane";

// FormState の型定義 (DetailPane 内部型と同型)
interface Subtask {
  text: string;
  checked: boolean;
}

type RecurrenceKind = "none" | "daily" | "weekly" | "monthlyDay" | "monthlyLast" | "every";
type ModelValue = "opus" | "sonnet" | "haiku" | null;
type Status = "未着手" | "進行中" | "確認待ち" | "完了" | "凍結";
type Priority = "P0" | "P1" | "P2" | "P3";

interface FormState {
  title: string;
  status: Status;
  priority: Priority;
  assignee: string;
  due: string;
  model: ModelValue;
  tagsCsv: string;
  relatedCsv: string;
  description: string;
  subtasks: Subtask[];
  memo: string;
  completedAt: string;
  estimateHoursStr: string;
  actualHoursStr: string;
  recurrenceKind: RecurrenceKind;
  recurrenceWeekday: number;
  recurrenceMonthDay: number;
  recurrenceEveryDays: number;
}

function makeForm(overrides: Partial<FormState> = {}): FormState {
  return {
    title: "デフォルトタスク",
    status: "未着手",
    priority: "P1",
    assignee: "花木",
    due: "2026-05-20",
    model: null,
    tagsCsv: "",
    relatedCsv: "",
    description: "",
    subtasks: [],
    memo: "",
    completedAt: "",
    estimateHoursStr: "",
    actualHoursStr: "",
    recurrenceKind: "none",
    recurrenceWeekday: 1,
    recurrenceMonthDay: 1,
    recurrenceEveryDays: 7,
    ...overrides,
  };
}

describe("threeWayMerge", () => {
  it("case 1: 全フィールド一致 → merged === nextBaseline, hasConflict=false", () => {
    const base = makeForm();
    const form = makeForm(); // user 編集なし
    const nextBaseline = makeForm(); // 外部変更なし

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(false);
    expect((merged as unknown as FormState).title).toBe(nextBaseline.title);
    expect((merged as unknown as FormState).status).toBe(nextBaseline.status);
  });

  it("case 2: user 編集のみ (1 フィールド) → form 値保持, hasConflict=false", () => {
    const base = makeForm();
    const form = makeForm({ title: "ユーザーが変えた" });
    const nextBaseline = makeForm(); // 外部変更なし (base と同じ)

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(false);
    expect((merged as unknown as FormState).title).toBe("ユーザーが変えた");
    // 他は nextBaseline のまま
    expect((merged as unknown as FormState).status).toBe(nextBaseline.status);
  });

  it("case 3: 外部編集のみ (1 フィールド) → nextBaseline 値を採用, hasConflict=false", () => {
    const base = makeForm();
    const form = makeForm(); // user 編集なし
    const nextBaseline = makeForm({ title: "外部が変えた" });

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(false);
    expect((merged as unknown as FormState).title).toBe("外部が変えた");
  });

  it("case 4: 偶然一致 (user と外部が同じ値に変えた) → form 値保持, hasConflict=false", () => {
    const base = makeForm();
    const form = makeForm({ title: "同じ値" });
    const nextBaseline = makeForm({ title: "同じ値" }); // 外部も同じ値

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(false);
    expect((merged as unknown as FormState).title).toBe("同じ値");
  });

  it("case 5: 真の conflict (user と外部が別々の値に変えた) → form 値保持 + hasConflict=true", () => {
    const base = makeForm();
    const form = makeForm({ title: "ユーザーの値" });
    const nextBaseline = makeForm({ title: "外部の値" }); // user と外部で異なる値

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(true);
    // user 値が保持される
    expect((merged as unknown as FormState).title).toBe("ユーザーの値");
  });

  it("case 6: subtasks の真 conflict → form.subtasks 保持 + hasConflict=true", () => {
    const base = makeForm({ subtasks: [{ text: "元のサブタスク", checked: false }] });
    const form = makeForm({ subtasks: [{ text: "ユーザーが変えた", checked: false }] });
    const nextBaseline = makeForm({ subtasks: [{ text: "外部が変えた", checked: true }] });

    const { merged, hasConflict } = threeWayMerge(form as never, base as never, nextBaseline as never);

    expect(hasConflict).toBe(true);
    // form の subtasks が保持される
    const mergedSubtasks = (merged as unknown as FormState).subtasks;
    expect(mergedSubtasks).toHaveLength(1);
    expect(mergedSubtasks[0]!.text).toBe("ユーザーが変えた");
  });
});
