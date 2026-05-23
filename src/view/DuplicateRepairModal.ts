import { App, Modal, Notice, Setting } from "obsidian";
import type { PathLock } from "../data/PathLock";
import type { SelfWriteTracker } from "../data/SelfWriteTracker";
import {
  detectDuplicates,
  calcMaxId,
  planRepair,
  executeRepair,
  type RenamePlan,
} from "../data/DuplicateIdRepair";

/**
 * 重複 ID 修復モーダル。
 * 1. open 時に tasksDir をスキャンして重複検出 + 振り直し計画を作る
 * 2. 件数 + 各 plan の oldFilename → newFilename を一覧表示
 * 3. ユーザー confirm で executeRepair 実行
 * 4. 結果 Notice 表示してモーダルを閉じる
 *
 * 移行 vault (v0.6.7 未満で他 vault からタスクを移行 → 採番が古い README 値から始まって既存と衝突)
 * の自己修復に使う。データ変更を伴うので必ず confirm を挟む。
 */
export class DuplicateRepairModal extends Modal {
  constructor(
    app: App,
    private readonly tasksDir: string,
    private readonly pathLock: PathLock,
    private readonly selfWriteTracker: SelfWriteTracker,
    private readonly onComplete: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "重複IDの修復" });

    const note = contentEl.createDiv({ cls: "kanban-repair-note" });
    note.style.marginBottom = "12px";
    note.style.fontSize = "var(--font-ui-small)";
    note.style.color = "var(--text-muted)";
    note.appendText(
      "他 vault から移行したタスクと新規作成タスクで K-NNNN が重複している場合に、",
    );
    note.createEl("br");
    note.appendText(
      "後から作られた側を最大ID+1から順に振り直します。元から居た側は据え置きです。",
    );

    let plans: RenamePlan[];
    try {
      plans = await this.computePlans();
    } catch (e) {
      contentEl.createEl("p", {
        text: `エラー: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    if (plans.length === 0) {
      contentEl.createEl("p", { text: "重複は見つかりませんでした。" });
      new Setting(contentEl).addButton((btn) =>
        btn
          .setButtonText("閉じる")
          .setCta()
          .onClick(() => this.close()),
      );
      return;
    }

    const summary = contentEl.createEl("p");
    summary.createEl("strong", { text: `${plans.length} 件のファイルを振り直します。` });

    const tableWrap = contentEl.createDiv();
    tableWrap.style.maxHeight = "300px";
    tableWrap.style.overflowY = "auto";
    tableWrap.style.border = "1px solid var(--background-modifier-border)";
    tableWrap.style.borderRadius = "4px";
    tableWrap.style.padding = "8px";
    tableWrap.style.fontSize = "var(--font-ui-small)";
    tableWrap.style.fontFamily = "var(--font-monospace)";
    tableWrap.style.marginBottom = "12px";

    for (const p of plans) {
      const row = tableWrap.createDiv();
      row.style.padding = "2px 0";
      row.appendText(`${p.oldFilename}  →  ${p.newFilename}`);
    }

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("キャンセル")
          .onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("振り直しを実行")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true).setButtonText("実行中...");
            const result = await executeRepair(
              this.app,
              this.tasksDir,
              plans,
              this.selfWriteTracker,
              this.pathLock,
            );
            if (result.failed.length === 0) {
              new Notice(
                `Kanban: ${result.succeeded.length} 件の重複IDを振り直しました`,
                6000,
              );
            } else {
              new Notice(
                `Kanban: ${result.succeeded.length} 件成功 / ${result.failed.length} 件失敗。コンソールを確認してください`,
                8000,
              );
              for (const f of result.failed) {
                console.error(
                  "[kanban] duplicate-id repair failed:",
                  f.plan.oldFilename,
                  f.error,
                );
              }
            }
            this.close();
            this.onComplete();
          }),
      );
  }

  private async computePlans(): Promise<RenamePlan[]> {
    const listed = await this.app.vault.adapter.list(this.tasksDir);
    // tasksDir 直下のファイルだけに限定。手動でサブフォルダを作っているユーザーが
    // listed.files に絶対パスで混入させた場合の誤マッチ防止。
    const prefix = this.tasksDir.endsWith("/") ? this.tasksDir : this.tasksDir + "/";
    const filenames: string[] = [];
    for (const full of listed.files) {
      if (!full.startsWith(prefix)) continue;
      const rel = full.slice(prefix.length);
      if (rel.includes("/")) continue;
      filenames.push(rel);
    }
    const groups = detectDuplicates(filenames);
    const maxId = calcMaxId(filenames);
    return planRepair(groups, maxId);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
