/**
 * Integration テスト用 in-memory Fake App / Vault。
 * TaskWriter.integration.test.ts / RecurrenceSpawner.test.ts で共有する。
 */
import matter from "gray-matter";

export function makeFakeApp(initialFiles: Record<string, string>) {
  const files: Record<string, string> = { ...initialFiles };
  const fileObjs: Record<string, Record<string, unknown>> = {};
  for (const path of Object.keys(initialFiles)) {
    fileObjs[path] = {
      path,
      basename: path.split("/").pop()!.replace(/\.md$/, ""),
      stat: { mtime: Date.now(), size: initialFiles[path]!.length },
    };
  }

  const vault = {
    read: async (file: Record<string, unknown>) => files[file.path as string]!,
    modify: async (file: Record<string, unknown>, content: string) => {
      files[file.path as string] = content;
      (file.stat as Record<string, unknown>).mtime = Date.now();
      (file.stat as Record<string, unknown>).size = content.length;
    },
    getAbstractFileByPath: (path: string) => fileObjs[path] ?? null,
    getMarkdownFiles: () => Object.values(fileObjs),
    create: async (path: string, content: string) => {
      files[path] = content;
      fileObjs[path] = {
        path,
        basename: path.split("/").pop()!.replace(/\.md$/, ""),
        stat: { mtime: Date.now(), size: content.length },
      };
      return fileObjs[path];
    },
    adapter: {
      exists: async (path: string) => path in files,
      read: async (path: string) => files[path]!,
      write: async (path: string, content: string) => {
        files[path] = content;
      },
    },
    rename: async (file: Record<string, unknown>, newPath: string) => {
      const old = file.path as string;
      const content = files[old]!;
      delete files[old];
      delete fileObjs[old];
      files[newPath] = content;
      file.path = newPath;
      fileObjs[newPath] = file;
    },
    createFolder: async (_path: string) => {
      // no-op for fake
    },
  };

  const fileManager = {
    processFrontMatter: async (
      file: Record<string, unknown>,
      fn: (fm: Record<string, unknown>) => void,
    ) => {
      const parsed = matter(files[file.path as string]!);
      fn(parsed.data);
      files[file.path as string] = matter.stringify(parsed.content, parsed.data);
    },
  };

  const app = { vault, fileManager };

  return { app, vault, fileManager, files, fileObjs };
}
