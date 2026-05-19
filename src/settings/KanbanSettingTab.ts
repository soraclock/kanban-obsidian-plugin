import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type KanbanPlugin from "../main";
import { DEFAULT_TASKS_DIR } from "../data/Constants";
import { normalizeTasksDir } from "./PluginSettings";

/**
 * Plugin の設定タブ。Obsidian の Settings → Community plugins → Kanban で表示される。
 *
 * 現状は tasksDir のみ。将来 A フェーズで status enum / frontmatter key map を追加予定。
 */
export class KanbanSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: KanbanPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Kanban 設定" });

    new Setting(containerEl)
      .setName("タスクフォルダ")
      .setDesc(
        `タスクファイル（K-XXXX-*.md）を保存する vault 内のフォルダパス。既定: ${DEFAULT_TASKS_DIR}。変更後は Obsidian を再起動してください。`,
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_TASKS_DIR)
          .setValue(this.plugin.settings.tasksDir)
          .onChange(async (value) => {
            const normalized = normalizeTasksDir(value);
            this.plugin.settings.tasksDir = normalized;
            await this.plugin.saveSettings();
          }),
      );

    const note = containerEl.createDiv({ cls: "setting-item-description" });
    note.style.marginTop = "8px";
    note.createEl("strong", { text: "注意: " });
    note.appendText(
      "フォルダパスの変更は次回 Obsidian 起動時から有効になります。既存のタスクファイルは自動で移動しません。",
    );

    containerEl.createEl("h3", { text: "操作" });
    new Setting(containerEl)
      .setName("設定を既定値にリセット")
      .setDesc("tasksDir を既定値に戻します。")
      .addButton((btn) =>
        btn
          .setButtonText("リセット")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.tasksDir = DEFAULT_TASKS_DIR;
            await this.plugin.saveSettings();
            this.display();
            new Notice("既定値にリセットしました。Obsidian を再起動してください。");
          }),
      );
  }
}
