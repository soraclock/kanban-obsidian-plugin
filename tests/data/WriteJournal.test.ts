import { describe, it, expect, beforeEach } from "vitest";
import { WriteJournal, type JournalEntry } from "../../src/data/WriteJournal";
import { PathLock } from "../../src/data/PathLock";
import type { Vault } from "obsidian";

function fakeVault(): Vault & { _files: Map<string, string> } {
  const files = new Map<string, string>();
  const adapter = {
    exists: async (p: string) => files.has(p),
    read: async (p: string) => {
      if (!files.has(p)) throw new Error("not found: " + p);
      return files.get(p)!;
    },
    write: async (p: string, content: string) => {
      files.set(p, content);
    },
  };
  return { adapter, _files: files } as unknown as Vault & { _files: Map<string, string> };
}

function entry(op: JournalEntry["op"], path: string): JournalEntry {
  return {
    ts: new Date().toISOString(),
    op,
    path,
    beforeHash: "before",
    afterHash: "after",
    actor: "user",
    approved: true,
  };
}

describe("WriteJournal", () => {
  it("appends entries as JSON lines", async () => {
    const vault = fakeVault();
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock());
    await j.append(entry("updateStatus", "a.md"));
    await j.append(entry("updateOrder", "b.md"));
    const text = vault._files.get(".journal.jsonl")!;
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).path).toBe("a.md");
    expect(JSON.parse(lines[1]!).path).toBe("b.md");
  });

  it("readAll returns parsed entries in append order", async () => {
    const vault = fakeVault();
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock());
    await j.append(entry("updateStatus", "x.md"));
    await j.append(entry("updateFrontmatter", "y.md"));
    const all = await j.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.op).toBe("updateStatus");
    expect(all[1]!.op).toBe("updateFrontmatter");
  });

  it("readAll returns empty when file does not exist", async () => {
    const vault = fakeVault();
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock());
    expect(await j.readAll()).toEqual([]);
  });

  it("serializes concurrent appends via PathLock (review Critical)", async () => {
    // 遅延付き adapter で race を発生させる
    const files = new Map<string, string>();
    const delayedAdapter = {
      exists: async (p: string) => files.has(p),
      read: async (p: string) => {
        await new Promise((r) => setTimeout(r, 10));
        if (!files.has(p)) throw new Error("not found");
        return files.get(p)!;
      },
      write: async (p: string, content: string) => {
        await new Promise((r) => setTimeout(r, 10));
        files.set(p, content);
      },
    };
    const v = { adapter: delayedAdapter } as unknown as Vault;
    const j = new WriteJournal(v, ".journal.jsonl", new PathLock());

    // 10 件を並行 append
    const promises = Array.from({ length: 10 }, (_, i) =>
      j.append(entry("updateStatus", `K-${String(i).padStart(4, "0")}.md`)),
    );
    await Promise.all(promises);

    // PathLock が効いていれば全 entry が残るはず
    const text = files.get(".journal.jsonl")!;
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(10);
    // 各 path が 1 度ずつ出現
    const paths = new Set(lines.map((l) => JSON.parse(l).path));
    expect(paths.size).toBe(10);
  });

  it("rotates archive when size exceeds threshold (review codex final)", async () => {
    const vault = fakeVault();
    // 閾値 500 bytes、keep 3 行
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock(), {
      rotationThresholdBytes: 500,
      rotationKeepLines: 3,
    });
    for (let i = 0; i < 20; i++) {
      await j.append(entry("updateStatus", `K-${String(i).padStart(4, "0")}.md`));
    }
    // メイン journal は keep 行数程度に収まる (rotation 後の append でさらに 1 増えるので 3〜4)
    const mainText = vault._files.get(".journal.jsonl")!;
    const mainLines = mainText.split("\n").filter(Boolean);
    expect(mainLines.length).toBeLessThanOrEqual(4);

    // archive ファイルが作成されている
    const archiveKeys = Array.from(vault._files.keys()).filter((p) =>
      p.startsWith(".journal.jsonl.archive."),
    );
    expect(archiveKeys.length).toBeGreaterThan(0);

    // archive + main を合わせた entries は 20 件
    let totalLines = mainLines.length;
    for (const k of archiveKeys) {
      totalLines += vault
        ._files.get(k)!
        .split("\n")
        .filter(Boolean).length;
    }
    expect(totalLines).toBe(20);
  });

  it("readLast after rotation returns only recent entries (no OOM, no archive read)", async () => {
    const vault = fakeVault();
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock(), {
      rotationThresholdBytes: 500,
      rotationKeepLines: 3,
    });
    for (let i = 0; i < 10; i++) {
      await j.append(entry("updateStatus", `K-${i}.md`));
    }
    const last2 = await j.readLast(2);
    expect(last2).toHaveLength(2);
    // 最後の 2 件は K-8 と K-9
    expect(last2[0]!.path).toBe("K-8.md");
    expect(last2[1]!.path).toBe("K-9.md");
  });

  it("readLast returns tail entries", async () => {
    const vault = fakeVault();
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock());
    for (let i = 0; i < 5; i++) {
      await j.append(entry("updateStatus", `K-${i}.md`));
    }
    const last3 = await j.readLast(3);
    expect(last3).toHaveLength(3);
    expect(last3[0]!.path).toBe("K-2.md");
    expect(last3[2]!.path).toBe("K-4.md");
  });

  it("skips malformed lines (best-effort recovery)", async () => {
    const vault = fakeVault();
    vault._files.set(
      ".journal.jsonl",
      `{"ts":"x","op":"updateStatus","path":"a","beforeHash":"x","afterHash":"y","actor":"user","approved":true}
broken-line
{"ts":"y","op":"updateOrder","path":"b","beforeHash":"x","afterHash":"y","actor":"user","approved":true}
`,
    );
    const j = new WriteJournal(vault, ".journal.jsonl", new PathLock());
    const all = await j.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.path).toBe("a");
    expect(all[1]!.path).toBe("b");
  });
});
