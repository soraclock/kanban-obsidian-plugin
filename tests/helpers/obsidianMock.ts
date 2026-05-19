/**
 * テスト環境用 obsidian stub。
 * DetailPane など obsidian API を参照するモジュールをテストから import する際に使う。
 * vitest.config.ts の resolve.alias で "obsidian" → このファイルに向ける。
 */
import yaml from "js-yaml";

export class Notice {
  constructor(public readonly message: string) {}
}

export const Platform = { isMobile: false };

/**
 * Obsidian の parseYaml / stringifyYaml と互換のテスト用実装。
 * 本物の Obsidian は内部で js-yaml を使っているので、ここでも js-yaml で揃える。
 */
export function parseYaml(input: string): unknown {
  return yaml.load(input);
}

export function stringifyYaml(input: unknown): string {
  return yaml.dump(input);
}
