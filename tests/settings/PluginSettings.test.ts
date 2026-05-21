import { describe, it, expect } from "vitest";
import { resolveAttachmentDir, normalizeTasksDir } from "../../src/settings/PluginSettings";

describe("resolveAttachmentDir", () => {
  it("空文字なら <tasksDir>/_attachments を返す", () => {
    expect(resolveAttachmentDir("", "tasks")).toBe("tasks/_attachments");
    expect(resolveAttachmentDir("", "秘書/tasks")).toBe("秘書/tasks/_attachments");
  });

  it("前後空白だけなら空文字と同じ扱い", () => {
    expect(resolveAttachmentDir("   ", "tasks")).toBe("tasks/_attachments");
  });

  it("前後の / は除去する", () => {
    expect(resolveAttachmentDir("/foo/bar/", "tasks")).toBe("foo/bar");
  });

  it(".. を含むパスは安全のため既定にフォールバック", () => {
    expect(resolveAttachmentDir("../evil", "tasks")).toBe("tasks/_attachments");
    expect(resolveAttachmentDir("foo/../bar", "tasks")).toBe("tasks/_attachments");
  });

  it("通常の相対パスはそのまま返す", () => {
    expect(resolveAttachmentDir("attachments", "tasks")).toBe("attachments");
    expect(resolveAttachmentDir("Media/Kanban", "tasks")).toBe("Media/Kanban");
  });
});

describe("normalizeTasksDir", () => {
  it("空文字は default に戻す", () => {
    expect(normalizeTasksDir("")).toBe("tasks");
  });

  it("前後 / を除去", () => {
    expect(normalizeTasksDir("/foo/")).toBe("foo");
  });

  it(".. は default にフォールバック", () => {
    expect(normalizeTasksDir("../evil")).toBe("tasks");
  });

  it("Windows 絶対パスは default にフォールバック", () => {
    expect(normalizeTasksDir("C:/foo")).toBe("tasks");
  });

  it("先頭 / は strip して相対化（既存仕様）", () => {
    expect(normalizeTasksDir("/abs/path")).toBe("abs/path");
  });

  it("非文字列は default", () => {
    expect(normalizeTasksDir(undefined)).toBe("tasks");
    expect(normalizeTasksDir(null)).toBe("tasks");
    expect(normalizeTasksDir(123)).toBe("tasks");
  });
});
