import { describe, it, expect } from "vitest";
import { PathLock } from "../../src/data/PathLock";

describe("PathLock", () => {
  it("serializes operations on the same path", async () => {
    const lock = new PathLock();
    const order: string[] = [];
    const a = lock.with("p", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "A";
    });
    const b = lock.with("p", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-end");
      return "B";
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe("A");
    expect(rb).toBe("B");
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("allows concurrent execution on different paths", async () => {
    const lock = new PathLock();
    const order: string[] = [];
    const a = lock.with("p1", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = lock.with("p2", async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // 異なる path は並列に走るので b-start が a-end より先
    expect(order[0]).toBe("a-start");
    expect(order[1]).toBe("b-start");
  });

  it("releases lock and cleans up map even on exception", async () => {
    const lock = new PathLock();
    await expect(
      lock.with("p", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(lock.size()).toBe(0);
    // 次の取得が即座に成功
    const result = await lock.with("p", async () => "ok");
    expect(result).toBe("ok");
  });

  it("isLocked reflects active locks", async () => {
    const lock = new PathLock();
    expect(lock.isLocked("p")).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const op = lock.with("p", async () => {
      await gate;
    });
    // 直後は isLocked=true
    await new Promise((r) => setTimeout(r, 1));
    expect(lock.isLocked("p")).toBe(true);
    release();
    await op;
    expect(lock.isLocked("p")).toBe(false);
  });
});
