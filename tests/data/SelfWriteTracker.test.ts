import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SelfWriteTracker } from "../../src/data/SelfWriteTracker";

describe("SelfWriteTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("markSelf → consumeIfSelf returns true, second call returns false", () => {
    const tracker = new SelfWriteTracker();
    tracker.markSelf("tasks/K-0001.md", "hash-abc");

    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-abc")).toBe(true);
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-abc")).toBe(false);
  });

  it("different hash returns false", () => {
    const tracker = new SelfWriteTracker();
    tracker.markSelf("tasks/K-0001.md", "hash-abc");

    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-xyz")).toBe(false);
    // 元の hash はまだ残っている
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-abc")).toBe(true);
  });

  it("different path returns false", () => {
    const tracker = new SelfWriteTracker();
    tracker.markSelf("tasks/K-0001.md", "hash-abc");

    expect(tracker.consumeIfSelf("tasks/K-0002.md", "hash-abc")).toBe(false);
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-abc")).toBe(true);
  });

  it("after TTL expiry consumeIfSelf returns false", async () => {
    const tracker = new SelfWriteTracker(1000);
    tracker.markSelf("tasks/K-0001.md", "hash-abc");

    await vi.advanceTimersByTimeAsync(1001);

    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-abc")).toBe(false);
  });

  it("multiple hashes for same path can all be consumed", () => {
    const tracker = new SelfWriteTracker();
    tracker.markSelf("tasks/K-0001.md", "hash-1");
    tracker.markSelf("tasks/K-0001.md", "hash-2");
    tracker.markSelf("tasks/K-0001.md", "hash-3");

    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-1")).toBe(true);
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-2")).toBe(true);
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-3")).toBe(true);
    expect(tracker.consumeIfSelf("tasks/K-0001.md", "hash-1")).toBe(false);
  });
});
