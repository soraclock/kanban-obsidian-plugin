import { describe, it, expect, vi } from "vitest";
import { AiTaskGateway } from "../../src/ai/AiTaskGateway";
import type { TaskWriter, WriteResult } from "../../src/data/TaskWriter";

function makeTaskWriterMock(): TaskWriter {
  return {
    updateTask: vi.fn(async (): Promise<WriteResult> => ({ newHash: "new-hash" })),
    updateStatus: vi.fn(async (): Promise<WriteResult> => ({ newHash: "new-hash" })),
    updateOrder: vi.fn(async (): Promise<WriteResult> => ({ newHash: "new-hash" })),
    updateStatusAndOrder: vi.fn(async (): Promise<WriteResult> => ({ newHash: "new-hash" })),
    archive: vi.fn(async () => ({ archivePath: "archive/path.md" })),
    restore: vi.fn(async () => ({ restoredPath: "tasks/path.md" })),
  } as unknown as TaskWriter;
}

describe("AiTaskGateway", () => {
  it("updateTask calls taskWriter.updateTask with actor='ai'", async () => {
    const writer = makeTaskWriterMock();
    const gateway = new AiTaskGateway(writer);

    await gateway.updateTask("tasks/K-0001.md", "hash-abc", { frontmatter: { title: "T" } });

    expect(writer.updateTask).toHaveBeenCalledWith(
      "tasks/K-0001.md",
      "hash-abc",
      { frontmatter: { title: "T" } },
      "ai",
    );
  });

  it("updateStatus calls taskWriter.updateStatus with actor='ai'", async () => {
    const writer = makeTaskWriterMock();
    const gateway = new AiTaskGateway(writer);

    await gateway.updateStatus("tasks/K-0001.md", "hash-abc", "進行中");

    expect(writer.updateStatus).toHaveBeenCalledWith(
      "tasks/K-0001.md",
      "hash-abc",
      "進行中",
      "ai",
    );
  });

  it("beginSession returns a string sessionId", () => {
    const writer = makeTaskWriterMock();
    const gateway = new AiTaskGateway(writer);

    const id = gateway.beginSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(gateway.sessionId).toBe(id);
  });

  it("endSession clears currentSessionId to null", () => {
    const writer = makeTaskWriterMock();
    const gateway = new AiTaskGateway(writer);

    gateway.beginSession();
    expect(gateway.sessionId).not.toBeNull();

    gateway.endSession();
    expect(gateway.sessionId).toBeNull();
  });

  it("beginSession generates unique IDs each call", () => {
    const writer = makeTaskWriterMock();
    const gateway = new AiTaskGateway(writer);

    const id1 = gateway.beginSession();
    gateway.endSession();
    const id2 = gateway.beginSession();

    expect(id1).not.toBe(id2);
  });
});
