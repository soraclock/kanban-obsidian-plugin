import { sha256 as sha256Hash } from "js-sha256";

/**
 * sha256 で content の hash を計算。
 * 楽観的並行制御（read→hash 取得→modify 前に再 read で hash 一致確認）に使う。
 *
 * 純 JS 実装の js-sha256 を使用。Obsidian モバイル（iOS/iPad）では Node.js の
 * crypto モジュールが使えないため、ライブラリを Node API から切り離してある。
 */
export function sha256(content: string): string {
  return sha256Hash(content);
}

export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
