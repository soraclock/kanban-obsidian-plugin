import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type KanbanPlugin from "../main";
import { DEFAULT_TASKS_DIR } from "../data/Constants";
import { normalizeTasksDir } from "./PluginSettings";
import { useBoardStore } from "../store/boardStore";
import { collectAllTags } from "../data/TaskFilter";
import { autoColorForTag, readableTextColor } from "../util/tagColor";

/**
 * Plugin の設定タブ。Obsidian の Settings → Community plugins → Kanban で表示される。
 *
 * - タスクフォルダ
 * - タグの並び順と色（v0.4.0）
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

    // タグの並び順と色
    this.renderTagSection(containerEl);

    containerEl.createEl("h3", { text: "操作" });
    new Setting(containerEl)
      .setName("設定を既定値にリセット")
      .setDesc("tasksDir を既定値に戻します（タグの並び/色は保持）。")
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

  private renderTagSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "タグの並び順と色" });

    const desc = containerEl.createDiv({ cls: "setting-item-description" });
    desc.style.marginBottom = "8px";
    desc.appendText(
      "ボード上のタグの表示順と色を設定します。自動色付け ON ならタグ名から決まった色が割り当てられ、個別に上書きしたいタグだけ手動で色を指定できます。",
    );

    new Setting(containerEl)
      .setName("自動で色を付ける")
      .setDesc("個別指定のないタグに、タグ名から計算した色を割り当てます。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoColorEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoColorEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    // 現在 vault にあるタグを収集
    const tasks = useBoardStore.getState().tasks;
    const presentTags = new Set(collectAllTags(tasks));
    const orderedTags = [...this.plugin.settings.tagOrder].filter((t) =>
      presentTags.has(t),
    );
    for (const t of presentTags) {
      if (!orderedTags.includes(t)) orderedTags.push(t);
    }

    if (orderedTags.length === 0) {
      const empty = containerEl.createDiv({ cls: "setting-item-description" });
      empty.style.marginTop = "8px";
      empty.appendText(
        "タスクに付いたタグがまだありません。タスクにタグを追加するとここに一覧が出ます。",
      );
      return;
    }

    const listEl = containerEl.createDiv({ cls: "kanban-tag-config-list" });
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.gap = "6px";
    listEl.style.marginTop = "12px";

    orderedTags.forEach((tag, idx) => {
      const row = listEl.createDiv({ cls: "kanban-tag-config-row" });
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.padding = "6px 8px";
      row.style.border = "1px solid var(--background-modifier-border)";
      row.style.borderRadius = "4px";
      row.style.background = "var(--background-secondary)";

      // 並び替えボタン (↑ ↓)
      const upBtn = row.createEl("button", { text: "↑", attr: { type: "button" } });
      upBtn.style.padding = "2px 8px";
      upBtn.style.cursor = "pointer";
      upBtn.disabled = idx === 0;
      upBtn.onclick = async () => {
        const order = [...orderedTags];
        const i = order.indexOf(tag);
        if (i > 0) {
          [order[i - 1], order[i]] = [order[i]!, order[i - 1]!];
          this.plugin.settings.tagOrder = order;
          await this.plugin.saveSettings();
          this.display();
        }
      };
      const downBtn = row.createEl("button", { text: "↓", attr: { type: "button" } });
      downBtn.style.padding = "2px 8px";
      downBtn.style.cursor = "pointer";
      downBtn.disabled = idx === orderedTags.length - 1;
      downBtn.onclick = async () => {
        const order = [...orderedTags];
        const i = order.indexOf(tag);
        if (i >= 0 && i < order.length - 1) {
          [order[i + 1], order[i]] = [order[i]!, order[i + 1]!];
          this.plugin.settings.tagOrder = order;
          await this.plugin.saveSettings();
          this.display();
        }
      };

      // タグチップ (実際の見た目プレビュー)
      const chip = row.createSpan({ text: tag, cls: "kanban-tag" });
      chip.style.flex = "1";
      chip.style.padding = "3px 10px";
      chip.style.borderRadius = "999px";
      chip.style.fontSize = "var(--font-ui-small)";
      const manualColor = this.plugin.settings.tagColors[tag];
      const effectiveColor = manualColor && manualColor.trim() !== ""
        ? manualColor
        : this.plugin.settings.autoColorEnabled
          ? autoColorForTag(tag)
          : "var(--background-modifier-border)";
      chip.style.backgroundColor = effectiveColor;
      chip.style.color = readableTextColor(effectiveColor);

      // 色ピッカー
      const colorInput = row.createEl("input", {
        type: "color",
        attr: { "aria-label": `${tag} の色` },
      });
      // type="color" は hsl を受け付けないので、現在の色を hex 風に変換できない場合は無視
      const hexInit = hexFromHsl(effectiveColor) ?? "#888888";
      colorInput.value = manualColor && /^#[0-9a-f]{6}$/i.test(manualColor)
        ? manualColor
        : hexInit;
      colorInput.style.width = "32px";
      colorInput.style.height = "32px";
      colorInput.style.padding = "0";
      colorInput.style.border = "1px solid var(--background-modifier-border)";
      colorInput.style.borderRadius = "4px";
      colorInput.style.cursor = "pointer";
      colorInput.onchange = async () => {
        this.plugin.settings.tagColors[tag] = colorInput.value;
        await this.plugin.saveSettings();
        this.display();
      };

      // 自動色に戻すボタン
      const resetBtn = row.createEl("button", {
        text: "自動",
        attr: { type: "button", title: "このタグの色を自動色に戻す" },
      });
      resetBtn.style.padding = "2px 8px";
      resetBtn.style.cursor = "pointer";
      resetBtn.disabled = !manualColor;
      resetBtn.onclick = async () => {
        delete this.plugin.settings.tagColors[tag];
        await this.plugin.saveSettings();
        this.display();
      };
    });

    // 全リセット
    const actions = containerEl.createDiv({ cls: "kanban-tag-config-actions" });
    actions.style.marginTop = "12px";
    actions.style.display = "flex";
    actions.style.gap = "8px";

    const resetAllBtn = actions.createEl("button", {
      text: "タグの並び順をリセット",
      attr: { type: "button" },
    });
    resetAllBtn.style.padding = "4px 12px";
    resetAllBtn.style.cursor = "pointer";
    resetAllBtn.onclick = async () => {
      this.plugin.settings.tagOrder = [];
      await this.plugin.saveSettings();
      this.display();
      new Notice("タグの並び順をリセットしました");
    };

    const resetColorsBtn = actions.createEl("button", {
      text: "タグの色をすべて自動に戻す",
      attr: { type: "button" },
    });
    resetColorsBtn.style.padding = "4px 12px";
    resetColorsBtn.style.cursor = "pointer";
    resetColorsBtn.onclick = async () => {
      this.plugin.settings.tagColors = {};
      await this.plugin.saveSettings();
      this.display();
      new Notice("すべてのタグの色を自動に戻しました");
    };
  }
}

/**
 * hsl() 形式の色文字列から近似 hex を返す (#rrggbb)。
 * 色ピッカーの初期値表示用。完全変換ではなく見た目近似で十分。
 */
function hexFromHsl(input: string): string | null {
  const m = input.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/i);
  if (!m) return /^#[0-9a-f]{6}$/i.test(input) ? input : null;
  const h = parseFloat(m[1]!) / 360;
  const s = parseFloat(m[2]!) / 100;
  const l = parseFloat(m[3]!) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): string => {
    const k = (n + h * 12) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
