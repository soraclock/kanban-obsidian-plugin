import { describe, it, expect } from "vitest";
import {
  autoColorForTag,
  resolveTagColor,
  readableTextColor,
  sortByTagOrder,
} from "../../src/util/tagColor";

describe("autoColorForTag", () => {
  it("同じタグ名は常に同じ色を返す（決定的）", () => {
    expect(autoColorForTag("foo")).toBe(autoColorForTag("foo"));
    expect(autoColorForTag("会議")).toBe(autoColorForTag("会議"));
  });

  it("hsl() 形式を返す", () => {
    const c = autoColorForTag("test");
    expect(c).toMatch(/^hsl\([\d.]+,\s*55%,\s*50%\)$/);
  });

  it("異なるタグ名は異なる色を返す（黄金角で hue 散らし）", () => {
    const colors = new Set<string>();
    for (const t of ["a", "b", "c", "d", "e"]) {
      colors.add(autoColorForTag(t));
    }
    expect(colors.size).toBe(5);
  });
});

describe("resolveTagColor", () => {
  it("manual 色があれば manual 優先", () => {
    expect(
      resolveTagColor("foo", { tagColors: { foo: "#ff0000" }, autoColorEnabled: true }),
    ).toBe("#ff0000");
  });

  it("manual なしで autoColor=true なら auto を返す", () => {
    const c = resolveTagColor("foo", { tagColors: {}, autoColorEnabled: true });
    expect(c).toMatch(/^hsl\(/);
  });

  it("manual なしで autoColor=false なら null を返す", () => {
    expect(
      resolveTagColor("foo", { tagColors: {}, autoColorEnabled: false }),
    ).toBeNull();
  });

  it("manual が空文字なら manual と見なさず auto fallback", () => {
    expect(
      resolveTagColor("foo", { tagColors: { foo: "" }, autoColorEnabled: true }),
    ).toMatch(/^hsl\(/);
  });
});

describe("readableTextColor", () => {
  it("hex 黒は白文字", () => {
    expect(readableTextColor("#000000")).toBe("#fff");
  });

  it("hex 白は黒文字", () => {
    expect(readableTextColor("#ffffff")).toBe("#000");
  });

  it("hex 黄色は黒文字（彩度高くても luminance で判定）", () => {
    expect(readableTextColor("#ffff00")).toBe("#000");
  });

  it("hex 濃赤は白文字", () => {
    expect(readableTextColor("#aa0000")).toBe("#fff");
  });

  it("hex 短縮 (#fff) も処理できる", () => {
    expect(readableTextColor("#fff")).toBe("#000");
    expect(readableTextColor("#000")).toBe("#fff");
  });

  it("hsl 黄色 (hue=60 L=50) は黒文字", () => {
    // critic Major: HSL の L=50% でも 黄色は luminance 高いので黒文字が正解
    expect(readableTextColor("hsl(60, 55%, 50%)")).toBe("#000");
  });

  it("hsl 緑黄 (hue=80 L=50) も黒文字", () => {
    expect(readableTextColor("hsl(80, 55%, 50%)")).toBe("#000");
  });

  it("hsl 青 (hue=240 L=50) は白文字", () => {
    expect(readableTextColor("hsl(240, 55%, 50%)")).toBe("#fff");
  });

  it("hsl 赤 (hue=0 L=50) は白文字", () => {
    expect(readableTextColor("hsl(0, 55%, 50%)")).toBe("#fff");
  });

  it("未知の形式 (CSS 変数) はテーマ依存 text-normal を返す", () => {
    expect(readableTextColor("var(--background-modifier-border)")).toBe(
      "var(--text-normal)",
    );
  });
});

describe("sortByTagOrder", () => {
  it("tagOrder に含まれるタグは指定順、未登録は末尾アルファベット順", () => {
    expect(sortByTagOrder(["x", "a", "b", "y"], ["b", "a"])).toEqual([
      "b",
      "a",
      "x",
      "y",
    ]);
  });

  it("tagOrder が空なら全てアルファベット順", () => {
    expect(sortByTagOrder(["c", "a", "b"], [])).toEqual(["a", "b", "c"]);
  });

  it("tags が空なら空配列", () => {
    expect(sortByTagOrder([], ["a"])).toEqual([]);
  });

  it("tagOrder にあって tags にないものは無視", () => {
    expect(sortByTagOrder(["a"], ["b", "a", "c"])).toEqual(["a"]);
  });
});
