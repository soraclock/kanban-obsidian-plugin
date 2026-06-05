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

const NEXT_ID_LINE_RE = /次のID:\s*\*\*K-\d{4,}\*\*/;

/**
 * _README.md 本文の「次のID: **K-NNNN**」を nextIdNum に更新した新文字列を返す。
 *
 * 案A (v0.6.13): 採番の真実は実在タスクファイルの最大 ID であり、この「次のID」は
 * 人間可読の参考値にすぎない。そのため:
 * - 行が存在すれば置換する
 * - 行が壊れている / 削除されている場合は throw せず、採番マーカー行を末尾に追記して
 *   自己修復する（以前は replace が黙って no-op し、次回 createTask が
 *   「次のID が見つかりません」で失敗する原因になっていた）。
 */
export function upsertReadmeNextId(readmeText: string, nextIdNum: number): string {
  const nextId = "K-" + String(nextIdNum).padStart(4, "0");
  if (NEXT_ID_LINE_RE.test(readmeText)) {
    return readmeText.replace(NEXT_ID_LINE_RE, `次のID: **${nextId}**`);
  }
  const trimmed = readmeText.replace(/\s*$/, "");
  return `${trimmed}\n\n次のID: **${nextId}**\n`;
}
