import type { App } from "obsidian";

/**
 * 新規 vault / iCloud で _README.md が未配置の場合に書き出す初期テンプレ。
 * 「次のID: **K-0001**」が必須（TaskCreator / RecurrenceSpawner の NEXT_ID_RE で参照）。
 */
export const INITIAL_README = `# Kanban Tasks

このフォルダは Kanban Task Board プラグインが管理するタスクファイル置き場です。
1 タスク = 1 Markdown ファイル。frontmatter にステータス・優先度などを記録します。

## ID 採番

次のID: **K-0001**

新規タスクは「+ 新規タスク」ボタンまたはコマンドパレットから採番されます。
`;

/**
 * tasksDir フォルダと \`_README.md\` を必要に応じて作成する。
 *
 * - フォルダが無ければ \`vault.createFolder\` で作成
 * - \`_README.md\` が無ければ \`INITIAL_README\` で作成
 * - 既に存在する場合は何もしない
 *
 * 新規ユーザーがゼロ設定で動くようにするため、TaskCreator / RecurrenceSpawner の
 * 冒頭で呼び出す。並列プロセスが先行作成した場合の race は無視する（作成済みなら成功扱い）。
 *
 * 呼び出し側は ProcessLock の内側で呼ぶこと（プロセス間 race を直列化するため）。
 */
export async function ensureTasksFolder(app: App, tasksDir: string): Promise<void> {
  if (!tasksDir || tasksDir.includes("..")) {
    throw new Error(`invalid tasksDir: ${tasksDir}`);
  }

  if (!app.vault.getAbstractFileByPath(tasksDir)) {
    try {
      await app.vault.createFolder(tasksDir);
    } catch (err) {
      if (!app.vault.getAbstractFileByPath(tasksDir)) {
        throw err;
      }
    }
  }

  const readmePath = `${tasksDir}/_README.md`;
  if (!app.vault.getAbstractFileByPath(readmePath)) {
    try {
      await app.vault.create(readmePath, INITIAL_README);
    } catch (err) {
      if (!app.vault.getAbstractFileByPath(readmePath)) {
        throw err;
      }
    }
  }
}
