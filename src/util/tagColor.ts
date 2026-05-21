/**
 * タグごとの色を解決する。
 *
 * - 個別設定 (settings.tagColors[tag]) があればそれを使う
 * - なければ settings.autoColorEnabled に従って自動色 (HSL) を生成 or null を返す
 *
 * 自動色はタグ名の文字列ハッシュから hue を算出するので、タグ名が同じなら常に同じ色になる
 * （セッションをまたいでも安定）。彩度と明度は dark/light どちらでも読めるよう中間値。
 */

const HUE_GOLDEN_ANGLE = 137.508; // 黄金角。隣接タグの色が近づかないように混ぜ込む

export interface TagColorSettings {
  tagColors: Record<string, string>;
  autoColorEnabled: boolean;
}

export function resolveTagColor(
  tag: string,
  settings: TagColorSettings,
): string | null {
  const manual = settings.tagColors[tag];
  if (typeof manual === "string" && manual.trim() !== "") return manual;
  if (!settings.autoColorEnabled) return null;
  return autoColorForTag(tag);
}

/**
 * タグ名から決定的に色を生成する。
 * 文字列の合計を黄金角に通して hue を散らす（隣接タグ名でも色が大きく違うように）。
 */
export function autoColorForTag(tag: string): string {
  let sum = 0;
  for (let i = 0; i < tag.length; i++) {
    // charCodeAt の桁の偏りを抑えるために位置で重み付け
    sum += tag.charCodeAt(i) * (i + 1);
  }
  const hue = (sum * HUE_GOLDEN_ANGLE) % 360;
  // 彩度 55% / 明度 50% は light / dark テーマどちらでも text-on-accent (白) で読める範囲
  return `hsl(${hue.toFixed(1)}, 55%, 50%)`;
}

/**
 * 背景色 (hsl or hex) に対して白文字 / 黒文字どちらが読みやすいかを判定する。
 * いずれも RGB に変換してから 知覚輝度（0.299R + 0.587G + 0.114B）で判定する。
 * HSL の L 値だけで判定すると黄色〜緑系（hue 40-100）で白が選ばれて読みにくい。
 */
export function readableTextColor(bg: string): string {
  const hsl = bg.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
  if (hsl) {
    const h = parseFloat(hsl[1]!) / 360;
    const s = parseFloat(hsl[2]!) / 100;
    const l = parseFloat(hsl[3]!) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    const luminance = 0.299 * f(0) + 0.587 * f(8) + 0.114 * f(4);
    return luminance > 0.6 ? "#000" : "#fff";
  }
  const hex = bg.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let r = 0;
    let g = 0;
    let b = 0;
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      r = parseInt(h[0]! + h[0]!, 16);
      g = parseInt(h[1]! + h[1]!, 16);
      b = parseInt(h[2]! + h[2]!, 16);
    } else if (h.length === 6 || h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? "#000" : "#fff";
  }
  // CSS 変数等の未知形式: テーマ依存なので Obsidian の text-normal に倒す
  return "var(--text-normal)";
}

/**
 * タグ配列を tagOrder で並び替える。未登録タグはアルファベット順で末尾に。
 */
export function sortByTagOrder(tags: string[], tagOrder: string[]): string[] {
  const orderMap = new Map<string, number>();
  tagOrder.forEach((t, i) => orderMap.set(t, i));
  const ordered: string[] = [];
  const unordered: string[] = [];
  for (const t of tags) {
    if (orderMap.has(t)) ordered.push(t);
    else unordered.push(t);
  }
  ordered.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));
  unordered.sort();
  return [...ordered, ...unordered];
}
