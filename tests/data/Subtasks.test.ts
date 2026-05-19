import { describe, it, expect } from "vitest";
import { parseSubtasks, completionRate } from "../../src/data/Subtasks";

describe("parseSubtasks", () => {
  it("returns empty when section is missing", () => {
    expect(parseSubtasks("## メモ\n- [ ] not in target section")).toEqual([]);
  });

  it("parses checked and unchecked items", () => {
    const body = `## 次のアクション
- [ ] サブ1
- [x] サブ2
- [X] サブ3 (大文字 X)
- [ ] サブ4
`;
    expect(parseSubtasks(body)).toEqual([
      { text: "サブ1", checked: false },
      { text: "サブ2", checked: true },
      { text: "サブ3 (大文字 X)", checked: true },
      { text: "サブ4", checked: false },
    ]);
  });

  it("stops at next h2 heading", () => {
    const body = `## 次のアクション
- [ ] include1
- [x] include2

## メモ
- [ ] not include
`;
    expect(parseSubtasks(body)).toEqual([
      { text: "include1", checked: false },
      { text: "include2", checked: true },
    ]);
  });

  it("ignores non-checkbox lines in section", () => {
    const body = `## 次のアクション
- [ ] real one
これは普通のテキスト
- not a checkbox
- [ ] another
`;
    expect(parseSubtasks(body)).toEqual([
      { text: "real one", checked: false },
      { text: "another", checked: false },
    ]);
  });

  it("supports indented checkboxes", () => {
    const body = `## 次のアクション
  - [ ] indented sub
`;
    expect(parseSubtasks(body)).toEqual([{ text: "indented sub", checked: false }]);
  });
});

describe("completionRate", () => {
  it("returns 0/0 for empty", () => {
    expect(completionRate([])).toEqual({ done: 0, total: 0 });
  });

  it("counts checked", () => {
    expect(
      completionRate([
        { text: "a", checked: true },
        { text: "b", checked: false },
        { text: "c", checked: true },
      ]),
    ).toEqual({ done: 2, total: 3 });
  });
});
