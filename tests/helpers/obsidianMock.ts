/**
 * テスト環境用 obsidian stub。
 * DetailPane など obsidian API を参照するモジュールをテストから import する際に使う。
 * vitest.config.ts の resolve.alias で "obsidian" → このファイルに向ける。
 */
export class Notice {
  constructor(public readonly message: string) {}
}

export const Platform = { isMobile: false };
