import * as crypto from "crypto";

/**
 * sha256 で content の hash を計算。
 * 楽観的並行制御（read→hash 取得→modify 前に再 read で hash 一致確認）に使う。
 */
export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
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
