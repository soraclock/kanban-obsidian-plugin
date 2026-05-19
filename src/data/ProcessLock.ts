import type { Vault } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

interface LockPayload {
  uuid: string;
  pid: number;
  owner: string;
  createdAt: string;
  ttlSeconds: number;
}

/**
 * 30s: Obsidian hot reload サイクルより長く、人間の操作スパンより短い。
 * acquire 中に Plugin が落ちても 30s 後に他プロセスが takeover できる。
 */
const DEFAULT_TTL_SECONDS = 30;
const DEFAULT_RETRY_INTERVAL_MS = 200;
const DEFAULT_RETRY_TIMEOUT_MS = 5000;

/**
 * `.kanban-lock` プロセス間 lock。
 *
 * 設計（review 反映後）：
 * - atomic create は POSIX 標準の `fs.open(path, 'wx')` を使う
 * - symlink TOCTOU 対策：`lstat` で symlink チェック、symlink なら拒否（review#Major2）
 * - stale takeover は **rename ベース atomic** で実行（review#Major2 二重ホルダー対策）
 *   stale な lock を一意の `.stale.<uuid>` に rename → POSIX atomic で先着 1 プロセスだけが成功
 * - 解放時は自分の owner UUID を検証してから unlink
 * - relativePath に `..` を含む場合は拒否（path traversal 防御）
 *
 * Phase 0 では acquire は呼ばれない（state.json 更新が発生しないため）。
 * Phase 1 以降の write 経路で acquire/release を呼ぶ。
 */
export class ProcessLock {
  private readonly uuid: string;
  private heldAbsPath: string | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly relativePath: string,
    private readonly owner: string = "obsidian-plugin",
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {
    if (relativePath.split(/[/\\]/).some((seg) => seg === ".." || seg === "")) {
      throw new Error(`relativePath must not contain '..' or empty segments: ${relativePath}`);
    }
    this.uuid = crypto.randomUUID();
  }

  private absolutePath(): string {
    const basePath = (this.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    if (!basePath) {
      throw new Error("vault.adapter.getBasePath is not available (desktop only)");
    }
    return path.join(basePath, this.relativePath);
  }

  private buildPayload(): LockPayload {
    return {
      uuid: this.uuid,
      pid: process.pid,
      owner: this.owner,
      createdAt: new Date().toISOString(),
      ttlSeconds: this.ttlSeconds,
    };
  }

  async acquire(opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RETRY_TIMEOUT_MS;
    const intervalMs = opts.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    const abs = this.absolutePath();

    while (Date.now() <= deadline) {
      try {
        await this.tryCreate(abs);
        this.heldAbsPath = abs;
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw e;

        if (await this.tryStaleTakeover(abs)) {
          this.heldAbsPath = abs;
          return true;
        }
        await sleep(intervalMs);
      }
    }
    return false;
  }

  private async tryCreate(abs: string): Promise<void> {
    // symlink TOCTOU 対策：作成前に lstat、symlink なら拒否（vault sandbox 突破防止）
    try {
      const stat = await fs.promises.lstat(abs);
      if (stat.isSymbolicLink()) {
        throw new Error(`lock path is a symlink, refusing to create: ${abs}`);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw e;
      // ENOENT = ファイル不在 = 正常パス
    }

    const payload = JSON.stringify(this.buildPayload(), null, 2);
    const fh = await fs.promises.open(abs, "wx");
    try {
      await fh.writeFile(payload, "utf8");
    } finally {
      await fh.close();
    }
  }

  /**
   * 既存 lock が stale なら rename ベースの atomic takeover を行う。
   *
   * 重要：`unlink` ベースだと、stale 判定した直後に別プロセスも同じ判定をし、
   * 後発が先発の有効な lock を消してしまう二重ホルダー race が成立する。
   * `rename(abs, abs + '.stale.<uuid>')` は POSIX で atomic なので、
   * 先着 1 プロセスだけが rename に成功する。
   */
  private async tryStaleTakeover(abs: string): Promise<boolean> {
    let existing: LockPayload;
    try {
      const raw = await fs.promises.readFile(abs, "utf8");
      existing = JSON.parse(raw) as LockPayload;
    } catch {
      return false;
    }

    const createdAt = Date.parse(existing.createdAt);
    if (Number.isNaN(createdAt)) return false;
    const ageMs = Date.now() - createdAt;
    if (ageMs <= existing.ttlSeconds * 1000) {
      return false;
    }

    const stalePath = `${abs}.stale.${this.uuid}`;
    try {
      await fs.promises.rename(abs, stalePath);
    } catch {
      // 別プロセスが先に rename したか、すでに削除済み
      return false;
    }

    console.warn("[kanban] stale lock taken over via rename", {
      previousOwner: existing.owner,
      previousUuid: existing.uuid,
      ageMs,
    });

    // 後始末（失敗しても致命的でない）
    try {
      await fs.promises.unlink(stalePath);
    } catch {
      /* ignore */
    }

    try {
      await this.tryCreate(abs);
    } catch {
      return false;
    }

    // 自分の lock が成立したか念のため再 read で確認
    try {
      const verifyRaw = await fs.promises.readFile(abs, "utf8");
      const verify = JSON.parse(verifyRaw) as LockPayload;
      return verify.uuid === this.uuid;
    } catch {
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.heldAbsPath) return;
    const abs = this.heldAbsPath;
    this.heldAbsPath = null;

    try {
      const raw = await fs.promises.readFile(abs, "utf8");
      const data = JSON.parse(raw) as LockPayload;
      if (data.uuid !== this.uuid) {
        console.warn("[kanban] release: not my lock, skip unlink", {
          existingUuid: data.uuid,
          myUuid: this.uuid,
        });
        return;
      }
      await fs.promises.unlink(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      console.warn("[kanban] release error:", e);
    }
  }

  isHeld(): boolean {
    return this.heldAbsPath !== null;
  }

  getUuid(): string {
    return this.uuid;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
