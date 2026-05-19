import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { ProcessLock } from "../../src/data/ProcessLock";

function makeMockVault(basePath: string) {
  return {
    adapter: {
      getBasePath: () => basePath,
    },
  } as unknown as import("obsidian").Vault;
}

describe("ProcessLock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kanban-lock-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("acquires lock when none exists", async () => {
    const lock = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    const ok = await lock.acquire({ timeoutMs: 1000, intervalMs: 50 });
    expect(ok).toBe(true);
    expect(lock.isHeld()).toBe(true);

    const raw = await fs.promises.readFile(path.join(tmpDir, ".kanban-lock"), "utf8");
    const data = JSON.parse(raw);
    expect(data.uuid).toBe(lock.getUuid());
    expect(data.owner).toBe("obsidian-plugin");
  });

  it("second acquire fails while first holds", async () => {
    const a = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock", "a", 60);
    const b = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock", "b", 60);

    expect(await a.acquire({ timeoutMs: 500, intervalMs: 50 })).toBe(true);
    expect(await b.acquire({ timeoutMs: 500, intervalMs: 50 })).toBe(false);
    expect(a.isHeld()).toBe(true);
    expect(b.isHeld()).toBe(false);
  });

  it("releases lock so next acquire succeeds", async () => {
    const a = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    const b = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");

    expect(await a.acquire({ timeoutMs: 500 })).toBe(true);
    await a.release();
    expect(a.isHeld()).toBe(false);
    expect(await b.acquire({ timeoutMs: 500 })).toBe(true);
  });

  it("release does not delete others' lock", async () => {
    const a = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    expect(await a.acquire({ timeoutMs: 500 })).toBe(true);

    // 別 ProcessLock インスタンスが「held」状態を偽造して release 試行
    // → 自分の UUID と一致しないので unlink されないはず
    const impostor = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    (impostor as unknown as { heldAbsPath: string }).heldAbsPath = path.join(tmpDir, ".kanban-lock");
    await impostor.release();

    // 元の lock ファイルは残っているはず
    const stillExists = await fs.promises
      .access(path.join(tmpDir, ".kanban-lock"))
      .then(() => true)
      .catch(() => false);
    expect(stillExists).toBe(true);
  });

  it("takes over stale lock (createdAt past ttl)", async () => {
    // 手動で stale lock を書く
    const stalePath = path.join(tmpDir, ".kanban-lock");
    const stalePayload = {
      uuid: crypto.randomUUID(),
      pid: 99999,
      owner: "ghost",
      createdAt: new Date(Date.now() - 60_000).toISOString(), // 60s 前
      ttlSeconds: 5,
    };
    await fs.promises.writeFile(stalePath, JSON.stringify(stalePayload), "utf8");

    const lock = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    const ok = await lock.acquire({ timeoutMs: 1000, intervalMs: 100 });
    expect(ok).toBe(true);

    const raw = await fs.promises.readFile(stalePath, "utf8");
    const data = JSON.parse(raw);
    expect(data.uuid).toBe(lock.getUuid());
  });

  it("rejects relativePath with '..' (path traversal)", () => {
    expect(() => new ProcessLock(makeMockVault(tmpDir), "../../etc/passwd")).toThrow(
      /relativePath must not contain/,
    );
    expect(() => new ProcessLock(makeMockVault(tmpDir), "a/../b")).toThrow(
      /relativePath must not contain/,
    );
  });

  it("refuses to create when path is a symlink (vault sandbox)", async () => {
    const victimPath = path.join(tmpDir, "victim.txt");
    const linkPath = path.join(tmpDir, ".kanban-lock");
    await fs.promises.writeFile(victimPath, "victim-content", "utf8");
    await fs.promises.symlink(victimPath, linkPath);

    const lock = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    await expect(lock.acquire({ timeoutMs: 300, intervalMs: 50 })).rejects.toThrow(/symlink/);

    // 標的ファイルは変更されていないはず
    const after = await fs.promises.readFile(victimPath, "utf8");
    expect(after).toBe("victim-content");
  });

  it("only one of concurrent acquires succeeds (race)", async () => {
    // 同じ tmpDir に対して 5 つの ProcessLock を同時に acquire
    const locks = Array.from({ length: 5 }, () => new ProcessLock(makeMockVault(tmpDir), ".kanban-lock", "race", 60));
    const results = await Promise.all(
      locks.map((l) => l.acquire({ timeoutMs: 500, intervalMs: 30 })),
    );
    const won = results.filter(Boolean).length;
    expect(won).toBe(1);

    // ファイル内容が勝者の UUID と一致
    const raw = await fs.promises.readFile(path.join(tmpDir, ".kanban-lock"), "utf8");
    const data = JSON.parse(raw);
    const winner = locks.find((l) => l.isHeld());
    expect(winner).toBeDefined();
    expect(data.uuid).toBe(winner!.getUuid());
  });

  it("rename-based stale takeover prevents double holder", async () => {
    // stale lock を配置
    const stalePath = path.join(tmpDir, ".kanban-lock");
    const stalePayload = {
      uuid: crypto.randomUUID(),
      pid: 99999,
      owner: "ghost",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ttlSeconds: 5,
    };
    await fs.promises.writeFile(stalePath, JSON.stringify(stalePayload), "utf8");

    // 複数プロセスが同時に takeover を試みる
    const locks = Array.from({ length: 4 }, () => new ProcessLock(makeMockVault(tmpDir), ".kanban-lock", "takeover", 60));
    const results = await Promise.all(
      locks.map((l) => l.acquire({ timeoutMs: 800, intervalMs: 40 })),
    );
    const won = results.filter(Boolean).length;
    // rename ベース atomic なら必ず 1 つだけ勝つ
    expect(won).toBe(1);
  });

  it("does not take over live lock", async () => {
    const livePath = path.join(tmpDir, ".kanban-lock");
    const livePayload = {
      uuid: crypto.randomUUID(),
      pid: 99999,
      owner: "live-other",
      createdAt: new Date().toISOString(),
      ttlSeconds: 30,
    };
    await fs.promises.writeFile(livePath, JSON.stringify(livePayload), "utf8");

    const lock = new ProcessLock(makeMockVault(tmpDir), ".kanban-lock");
    const ok = await lock.acquire({ timeoutMs: 500, intervalMs: 50 });
    expect(ok).toBe(false);

    // 元の lock は残っているはず
    const raw = await fs.promises.readFile(livePath, "utf8");
    const data = JSON.parse(raw);
    expect(data.owner).toBe("live-other");
  });
});
