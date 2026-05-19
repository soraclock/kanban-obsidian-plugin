import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { dndState } from "../../src/view/dndState";

describe("dndState (drag後 click suppress)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses clicks while drag is in progress", () => {
    dndState.onDragStart();
    expect(dndState.shouldSuppressClick()).toBe(true);
    // 時間が経っても drag 中は true
    vi.advanceTimersByTime(1000);
    expect(dndState.shouldSuppressClick()).toBe(true);
    dndState.onDragEnd();
  });

  it("suppresses clicks for 200ms after drag ends, then clears", () => {
    dndState.onDragStart();
    dndState.onDragEnd();
    expect(dndState.shouldSuppressClick()).toBe(true);
    vi.advanceTimersByTime(199);
    expect(dndState.shouldSuppressClick()).toBe(true);
    vi.advanceTimersByTime(2); // total 201
    expect(dndState.shouldSuppressClick()).toBe(false);
  });

  it("onDragCancel triggers the same suppress window", () => {
    dndState.onDragStart();
    dndState.onDragCancel();
    expect(dndState.shouldSuppressClick()).toBe(true);
    vi.advanceTimersByTime(201);
    expect(dndState.shouldSuppressClick()).toBe(false);
  });
});
