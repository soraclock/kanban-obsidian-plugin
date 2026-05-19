import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VaultWatcher } from "../../src/data/VaultWatcher";
import { SelfWriteTracker } from "../../src/data/SelfWriteTracker";
import type { Task } from "../../src/data/Task";

/** vault.on で登録されるハンドラを取り出せる簡易 EventEmitter モック */
function createMockApp() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {
    modify: [],
    delete: [],
    rename: [],
  };
  const offRefs = new Set<unknown>();
  const vault = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers[event]!.push(cb);
      const ref = { event, cb };
      return ref;
    },
    offref(ref: unknown) {
      offRefs.add(ref);
    },
  };
  return {
    app: { vault } as unknown as Parameters<typeof Object>[0],
    vault,
    handlers,
    offRefs,
    emit(event: keyof typeof handlers, ...args: unknown[]) {
      for (const h of handlers[event]!) h(...args);
    },
  };
}

function makeFakeFile(path: string) {
  return { path } as unknown as { path: string };
}

function makeFakeTask(filePath: string): Task {
  return {
    id: "K-0001",
    title: "t",
    status: "未着手",
    assignee: "x",
    priority: "P1",
    created: "2026-05-11",
    updated: "2026-05-11",
    tags: [],
    order: 1,
    filePath,
    contentHash: "hash",
    bodyMarkdown: "",
    subtasks: [],
  };
}

describe("VaultWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces same-path modify events into a single reload", async () => {
    const env = createMockApp();
    const readOne = vi.fn(async (p: string) => makeFakeTask(p));
    const upsertTask = vi.fn();
    const removeTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 50 },
    );
    watcher.start();

    const file = makeFakeFile("秘書/tasks/K-0001-x.md");
    env.emit("modify", file);
    env.emit("modify", file);
    env.emit("modify", file);

    await vi.advanceTimersByTimeAsync(60);
    // microtask 待ち
    await Promise.resolve();
    expect(readOne).toHaveBeenCalledTimes(1);
    expect(upsertTask).toHaveBeenCalledTimes(1);
    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({ filePath: file.path }));
    watcher.dispose();
  });

  it("ignores files outside tasksDir (journal / archive / other dir)", async () => {
    const env = createMockApp();
    const readOne = vi.fn(async () => null);
    const upsertTask = vi.fn();
    const removeTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 10 },
    );
    watcher.start();

    env.emit("modify", makeFakeFile("秘書/tasks/.kanban-journal.jsonl"));
    env.emit("modify", makeFakeFile("秘書/tasks/_archive/K-0001.md"));
    env.emit("modify", makeFakeFile("other/dir/K-0001-x.md"));
    env.emit("modify", makeFakeFile("秘書/tasks/README.md"));

    await vi.advanceTimersByTimeAsync(30);
    await Promise.resolve();
    expect(readOne).not.toHaveBeenCalled();
    expect(upsertTask).not.toHaveBeenCalled();
    expect(removeTask).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("delete event removes task immediately (no debounce)", () => {
    const env = createMockApp();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne: vi.fn() } as never,
      "秘書/tasks",
      { upsertTask: vi.fn(), removeTask: vi.fn() },
      { debounceMs: 10 },
    );
    watcher.start();
    const callbacks = (watcher as unknown as { callbacks: { removeTask: ReturnType<typeof vi.fn> } })
      .callbacks;

    env.emit("delete", makeFakeFile("秘書/tasks/K-0001-x.md"));
    expect(callbacks.removeTask).toHaveBeenCalledWith("秘書/tasks/K-0001-x.md");
    watcher.dispose();
  });

  it("rename event removes old path and reloads new path", async () => {
    const env = createMockApp();
    const readOne = vi.fn(async (p: string) => makeFakeTask(p));
    const upsertTask = vi.fn();
    const removeTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 10 },
    );
    watcher.start();

    const newFile = makeFakeFile("秘書/tasks/K-0001-new.md");
    env.emit("rename", newFile, "秘書/tasks/K-0001-old.md");
    expect(removeTask).toHaveBeenCalledWith("秘書/tasks/K-0001-old.md");

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(readOne).toHaveBeenCalledWith(newFile.path);
    expect(upsertTask).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it("dispose unregisters handlers and clears pending timers", async () => {
    const env = createMockApp();
    const readOne = vi.fn();
    const upsertTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask: vi.fn() },
      { debounceMs: 100 },
    );
    watcher.start();
    env.emit("modify", makeFakeFile("秘書/tasks/K-0001-x.md"));
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(readOne).not.toHaveBeenCalled();
    expect(upsertTask).not.toHaveBeenCalled();
    // 4 つ登録 (modify, delete, rename) → 3 つ offref される
    expect(env.offRefs.size).toBe(3);
  });

  it("readOne returning null causes removeTask (= file no longer a valid task)", async () => {
    const env = createMockApp();
    const readOne = vi.fn(async () => null);
    const upsertTask = vi.fn();
    const removeTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 10 },
    );
    watcher.start();
    env.emit("modify", makeFakeFile("秘書/tasks/K-0001-x.md"));
    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    expect(removeTask).toHaveBeenCalledWith("秘書/tasks/K-0001-x.md");
    expect(upsertTask).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it("rename clears pending old path timer (no stale reload after rename)", async () => {
    const env = createMockApp();
    const readOne = vi.fn(async (p: string) => makeFakeTask(p));
    const upsertTask = vi.fn();
    const removeTask = vi.fn();
    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 50 },
    );
    watcher.start();

    // 1. modify を発火 → debounce タイマーが立つ
    env.emit("modify", makeFakeFile("秘書/tasks/K-0001-old.md"));
    // 2. デバウンス前に rename
    env.emit(
      "rename",
      makeFakeFile("秘書/tasks/K-0001-new.md"),
      "秘書/tasks/K-0001-old.md",
    );
    // 3. デバウンス時間経過
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    // 4. old path に対する readOne は呼ばれない (timer がクリアされた)
    //    new path の readOne のみ 1 回
    expect(readOne).toHaveBeenCalledTimes(1);
    expect(readOne).toHaveBeenCalledWith("秘書/tasks/K-0001-new.md");
    // old path に対する removeTask は同期 (rename 内で即実行)
    expect(removeTask).toHaveBeenCalledWith("秘書/tasks/K-0001-old.md");
    watcher.dispose();
  });

  it("selfWriteTracker.consumeIfSelf=true skips upsertTask (echo skip)", async () => {
    const env = createMockApp();
    const selfWriteTracker = new SelfWriteTracker();
    const filePath = "秘書/tasks/K-0001-x.md";
    const selfHash = "self-written-hash";

    const task = makeFakeTask(filePath);
    task.contentHash = selfHash;
    const readOne = vi.fn(async () => task);
    const upsertTask = vi.fn();
    const removeTask = vi.fn();

    const watcher = new VaultWatcher(
      env.app as never,
      { readOne } as never,
      "秘書/tasks",
      { upsertTask, removeTask },
      { debounceMs: 10, selfWriteTracker },
    );
    watcher.start();

    // self-write を記録してから modify イベントを発火
    selfWriteTracker.markSelf(filePath, selfHash);
    env.emit("modify", makeFakeFile(filePath));

    await vi.advanceTimersByTimeAsync(20);
    await Promise.resolve();

    // readOne は呼ばれるが upsertTask は呼ばれない (echo skip)
    expect(readOne).toHaveBeenCalledTimes(1);
    expect(upsertTask).not.toHaveBeenCalled();
    expect(removeTask).not.toHaveBeenCalled();
    watcher.dispose();
  });
});
