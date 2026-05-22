import { Plugin, WorkspaceLeaf, Notice, TFile, Platform } from "obsidian";
import { PluginLifecycle } from "./lifecycle/PluginLifecycle";
// Node 依存（fs / process / crypto）を持つ ProcessLock / EnvironmentGate / LegacyKanbanDetector
// は、デスクトップでのみ動的 import する。型は import type で型情報だけ取得して runtime コードに含めない。
import type { EnvironmentGate as EnvironmentGateType } from "./env/EnvironmentGate";
import type { ProcessLock as ProcessLockType } from "./data/ProcessLock";
import { KanbanView, KANBAN_VIEW_TYPE } from "./view/KanbanView";
import { LEGACY_KANBAN_PORT, journalPathFor, lockPathFor } from "./data/Constants";
import { DEFAULT_SETTINGS, normalizeTasksDir, type PluginSettings } from "./settings/PluginSettings";
import { KanbanSettingTab } from "./settings/KanbanSettingTab";
import { PathLock } from "./data/PathLock";
import { WriteJournal } from "./data/WriteJournal";
import { TaskWriter } from "./data/TaskWriter";
import { TaskRepository } from "./data/TaskRepository";
import { VaultWatcher } from "./data/VaultWatcher";
import { OperationHistory } from "./data/OperationHistory";
import { ConflictError } from "./data/ContentHash";
import { planRecompactOrders } from "./data/OrderCompaction";
import { RecurrenceSpawner } from "./data/RecurrenceSpawner";
import { SelfWriteTracker } from "./data/SelfWriteTracker";
import { AiTaskGateway } from "./ai/AiTaskGateway";
import { TaskCreator } from "./data/TaskCreator";
import { useBoardStore } from "./store/boardStore";
import type { PluginContext } from "./view/PluginContext";

export default class KanbanPlugin extends Plugin {
  /** 永続設定（data.json に保存）。onload で必ずロードされる */
  settings: PluginSettings = { ...DEFAULT_SETTINGS };

  private lifecycle?: PluginLifecycle;
  private gate?: EnvironmentGateType;
  private processLock?: ProcessLockType;
  private legacyLockToken: string | null = null;

  // Phase 2: write 系サービス
  private pathLock?: PathLock;
  private journal?: WriteJournal;
  private taskWriter?: TaskWriter;
  private taskRepository?: TaskRepository;
  private vaultWatcher?: VaultWatcher;
  private recurrenceSpawner?: RecurrenceSpawner;
  private history?: OperationHistory;
  // Phase 5: AI write 前置き工事
  private selfWriteTracker?: SelfWriteTracker;
  private aiTaskGateway?: AiTaskGateway;
  // Phase 7 (タスク追加): 各列の「+」ボタンから新規タスクを作成する
  private taskCreator?: TaskCreator;

  async onload() {
    console.log("[kanban] plugin loading...");

    await this.loadSettings();
    // 起動時にタグ設定・添付保存先を boardStore に同期 (view が初期描画時に反映できるように)
    useBoardStore.getState().setTagConfig({
      tagOrder: this.settings.tagOrder,
      tagColors: this.settings.tagColors,
      autoColorEnabled: this.settings.autoColorEnabled,
    });
    useBoardStore.getState().setAttachmentDir(this.settings.attachmentDir);
    useBoardStore.getState().setDefaultAssignee(this.settings.defaultAssignee);

    this.lifecycle = new PluginLifecycle(this);
    await this.lifecycle.onLoad();

    const tasksDir = this.settings.tasksDir;
    const journalPath = journalPathFor(tasksDir);

    // モバイル（iOS/Android）では Node.js fs / process / crypto が使えないため、
    // ProcessLock と EnvironmentGate の legacy detection を skip する。
    // ProcessLock は 1 vault に 1 Obsidian インスタンスしか起動しない前提のモバイルでは
    // 元々不要。EnvironmentGate の旧 Hono kanban 検知は corp 専用なので skip しても安全。
    if (!Platform.isMobile) {
      const lockPath = lockPathFor(tasksDir);
      const { ProcessLock } = await import("./data/ProcessLock");
      const { EnvironmentGate } = await import("./env/EnvironmentGate");
      this.processLock = new ProcessLock(this.app.vault, lockPath);
      this.gate = new EnvironmentGate(this.app, {
        legacyKanbanPort: LEGACY_KANBAN_PORT,
        processLock: this.processLock,
        tasksDir,
      });
      const gateResult = await this.gate.check();
      this.legacyLockToken = gateResult.legacyLockToken;
      this.lifecycle.applyGateResult(gateResult);
      useBoardStore.getState().setReadOnly(gateResult.mode === "readOnly");
    } else {
      console.log("[kanban] mobile detected: skipping ProcessLock + EnvironmentGate");
    }

    // Phase 2 services
    this.pathLock = new PathLock();
    this.journal = new WriteJournal(this.app.vault, journalPath, this.pathLock);
    // Phase 5: SelfWriteTracker を TaskWriter / VaultWatcher の両方に渡す
    this.selfWriteTracker = new SelfWriteTracker();
    this.taskWriter = new TaskWriter(
      this.app,
      this.pathLock,
      this.journal,
      this.selfWriteTracker,
      this.gate ? () => this.gate!.isWriteAllowed() : undefined,
      this.processLock,
    );
    this.history = new OperationHistory();

    // Phase 3 services
    this.taskRepository = new TaskRepository(this.app, tasksDir);
    this.vaultWatcher = new VaultWatcher(
      this.app,
      this.taskRepository,
      tasksDir,
      {
        upsertTask: (task) => useBoardStore.getState().upsertTask(task),
        removeTask: (path) => useBoardStore.getState().removeTask(path),
        onError: (path, msg) =>
          new Notice(`タスク再読込失敗: ${path.split("/").pop()} (${msg.slice(0, 60)})`),
      },
      { selfWriteTracker: this.selfWriteTracker },
    );
    this.vaultWatcher.start();

    // Phase 5: AiTaskGateway
    this.aiTaskGateway = new AiTaskGateway(this.taskWriter);

    // 定期タスクの「今回分を完了」処理 (履歴インスタンス生成 + 親 due 更新)
    this.recurrenceSpawner = new RecurrenceSpawner(
      this.app,
      tasksDir,
      this.pathLock,
      this.selfWriteTracker,
      this.journal,
      this.history,
      this.gate ? () => this.gate!.isWriteAllowed() : undefined,
      this.processLock,
    );

    // Phase 7 (タスク追加): 各列の「+」ボタンから新規タスクを作成する
    this.taskCreator = new TaskCreator(
      this.app,
      tasksDir,
      this.pathLock,
      this.journal,
      this.selfWriteTracker,
      this.gate ? () => this.gate!.isWriteAllowed() : undefined,
      this.processLock,
      // v0.6.6: 設定値を都度参照。設定タブで変更されても次回作成から反映される
      () => this.settings.defaultAssignee,
    );

    // 削除されたタスクファイルの履歴を掃除 (review security#Minor 反映)
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.path.startsWith(tasksDir + "/")) {
          const removed = this.history?.removeByPath(file.path) ?? 0;
          if (removed > 0) {
            console.log(`[kanban] removed ${removed} history entries for deleted ${file.path}`);
          }
        }
      }),
    );

    this.addSettingTab(new KanbanSettingTab(this.app, this));

    const ctx: PluginContext = {
      taskWriter: this.taskWriter,
      taskRepository: this.taskRepository,
      history: this.history,
      pathLock: this.pathLock,
      journal: this.journal,
      recurrenceSpawner: this.recurrenceSpawner,
      aiTaskGateway: this.aiTaskGateway,
      taskCreator: this.taskCreator,
      app: this.app,
      tasksDir,
    };

    this.registerView(KANBAN_VIEW_TYPE, (leaf) => new KanbanView(leaf, ctx));

    this.addRibbonIcon("kanban", "Open Kanban", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-kanban",
      name: "Open Kanban",
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: "kanban-undo-last",
      name: "Kanban: Undo Last",
      callback: () => this.undoLast(),
    });

    this.addCommand({
      id: "kanban-recompact-order",
      name: "Kanban: Recompact Order",
      callback: () => this.recompactOrder(),
    });

    // Phase 10 (P3): 主要操作をコマンドパレット + ホットキー設定に登録。
    // Obsidian の hotkey 設定画面から任意のキーをバインド可能。
    this.addCommand({
      id: "kanban-view-board",
      name: "Kanban: ビュー切替 - ボード",
      callback: () => useBoardStore.getState().setCurrentView("board"),
    });
    this.addCommand({
      id: "kanban-view-completed",
      name: "Kanban: ビュー切替 - 完了タブ",
      callback: () => useBoardStore.getState().setCurrentView("completed"),
    });
    this.addCommand({
      id: "kanban-view-frozen",
      name: "Kanban: ビュー切替 - 凍結タブ",
      callback: () => useBoardStore.getState().setCurrentView("frozen"),
    });
    this.addCommand({
      id: "kanban-layout-board",
      name: "Kanban: レイアウト - ボード",
      callback: () => useBoardStore.getState().setLayoutMode("board"),
    });
    this.addCommand({
      id: "kanban-layout-list",
      name: "Kanban: レイアウト - リスト",
      callback: () => useBoardStore.getState().setLayoutMode("list"),
    });
    this.addCommand({
      id: "kanban-layout-focus",
      name: "Kanban: レイアウト - フォーカス",
      callback: () => useBoardStore.getState().setLayoutMode("focus"),
    });
    this.addCommand({
      id: "kanban-layout-calendar",
      name: "Kanban: レイアウト - カレンダー",
      callback: () => useBoardStore.getState().setLayoutMode("calendar"),
    });
    this.addCommand({
      id: "kanban-filter-reset",
      name: "Kanban: フィルタを全てクリア",
      callback: () => useBoardStore.getState().resetFilter(),
    });
    this.addCommand({
      id: "kanban-new-task",
      name: "Kanban: 新規タスクを作成（未着手）",
      callback: async () => {
        if (!this.taskCreator) return;
        const title = window.prompt("新規タスクのタイトル");
        if (!title || title.trim() === "") return;
        try {
          const r = await this.taskCreator.createTask({
            title: title.trim(),
            status: "未着手",
          });
          new Notice(`作成しました: ${r.newId}`);
          useBoardStore.getState().requestReload();
          // 作成直後に詳細を開いて編集導線へ繋ぐ
          try {
            const fresh = await this.taskRepository?.readOne(r.newFilePath);
            if (fresh) {
              useBoardStore.getState().upsertTask(fresh);
              useBoardStore.getState().openDetail(r.newFilePath);
            }
          } catch {
            /* readOne 失敗は requestReload で回収 */
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
          new Notice(`作成失敗: ${msg}`);
        }
      },
    });
    this.addCommand({
      id: "kanban-detail-close",
      name: "Kanban: 詳細ペインを閉じる",
      callback: () => useBoardStore.getState().closeDetail(),
    });

    // Phase 10 (P0): 起動時の期限通知。layout 完了後に 1 回だけ実行し、当日中は再通知しない。
    this.app.workspace.onLayoutReady(() => {
      void this.runDueDateNotice();
      void this.migrateRecurringTasksToScheduledStatus();
    });

    console.log("[kanban] plugin loaded.", {
      mobile: Platform.isMobile,
      legacyLocked: this.legacyLockToken != null,
    });
  }

  /**
   * recurrence を持つアクティブタスク (status=未着手/進行中/確認待ち) を status=定期 に移行する。
   * data.json の recurringMigrationDone フラグで 1 度だけ実行。
   * 完了/凍結タスクは履歴として尊重し書き換えない。
   */
  private async migrateRecurringTasksToScheduledStatus(): Promise<void> {
    if (!this.taskRepository || !this.taskWriter) return;
    try {
      const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
      if (data.recurringMigrationDone === true) return;
      const { tasks } = await this.taskRepository.listAll();
      const targets = tasks.filter((t) => {
        const tx = t as typeof t & { recurrence?: string | null };
        if (!tx.recurrence) return false;
        return t.status === "未着手" || t.status === "進行中" || t.status === "確認待ち";
      });
      let migrated = 0;
      let failed = 0;
      for (const t of targets) {
        try {
          await this.taskWriter.updateStatus(t.filePath, t.contentHash, "定期");
          migrated++;
        } catch (e) {
          failed++;
          console.warn(`[kanban] migration skipped: ${t.filePath}`, e);
        }
      }
      // codex review 反映: 失敗があれば flag を立てず次回再試行する
      if (failed === 0) {
        await this.saveData({ ...data, recurringMigrationDone: true });
      } else {
        console.warn(
          `[kanban] recurring migration: ${migrated} succeeded / ${failed} failed. Will retry on next launch.`,
        );
      }
      if (migrated > 0) {
        new Notice(`定期タスク ${migrated} 件を「定期」列に移しました`);
        useBoardStore.getState().requestReload();
      }
      if (failed > 0) {
        new Notice(
          `定期タスク移行: ${failed} 件失敗（次回起動時に再試行します）`,
          8000,
        );
      }
    } catch (e) {
      console.warn("[kanban] recurring migration failed:", e);
    }
  }

  /**
   * Phase 10 (P0): 起動時の期限チェック → Notice 通知。
   * 1 日 1 回（plugin data.json の lastNotifyDate で抑止）。完了 / 凍結タスクは除外。
   */
  private async runDueDateNotice(): Promise<void> {
    if (!this.taskRepository) return;
    try {
      const today = todayYmd();
      const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
      if (data.lastNotifyDate === today) return;
      const { tasks } = await this.taskRepository.listAll();
      let overdue = 0;
      let dueToday = 0;
      for (const t of tasks) {
        if (t.status === "完了" || t.status === "凍結") continue;
        if (!t.due) continue;
        if (t.due < today) overdue++;
        else if (t.due === today) dueToday++;
      }
      if (overdue > 0 || dueToday > 0) {
        const parts: string[] = [];
        if (overdue > 0) parts.push(`期限超過 ${overdue} 件`);
        if (dueToday > 0) parts.push(`今日期限 ${dueToday} 件`);
        new Notice(`Kanban: ${parts.join(" / ")}`, 10000);
      }
      await this.saveData({ ...data, lastNotifyDate: today });
    } catch (e) {
      console.warn("[kanban] due-date notice failed:", e);
    }
  }

  async loadSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    this.settings = {
      tasksDir: normalizeTasksDir(data.tasksDir),
      tagOrder: Array.isArray(data.tagOrder)
        ? (data.tagOrder.filter((s) => typeof s === "string") as string[])
        : [],
      tagColors:
        data.tagColors && typeof data.tagColors === "object"
          ? Object.fromEntries(
              Object.entries(data.tagColors as Record<string, unknown>).filter(
                ([, v]) => typeof v === "string",
              ) as [string, string][],
            )
          : {},
      autoColorEnabled: data.autoColorEnabled !== false, // 未設定 / undefined は true
      attachmentDir: typeof data.attachmentDir === "string" ? data.attachmentDir : "",
      defaultAssignee:
        typeof data.defaultAssignee === "string" ? data.defaultAssignee : "",
    };
  }

  /**
   * Obsidian Sync 等で data.json が外部更新されたときに Obsidian が呼ぶ。
   * loadSettings を再実行して boardStore のタグ設定を最新に同期する。
   */
  async onExternalSettingsChange(): Promise<void> {
    await this.loadSettings();
    useBoardStore.getState().setTagConfig({
      tagOrder: this.settings.tagOrder,
      tagColors: this.settings.tagColors,
      autoColorEnabled: this.settings.autoColorEnabled,
    });
    useBoardStore.getState().setAttachmentDir(this.settings.attachmentDir);
    useBoardStore.getState().setDefaultAssignee(this.settings.defaultAssignee);
  }

  async saveSettings(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    await this.saveData({
      ...data,
      tasksDir: this.settings.tasksDir,
      tagOrder: this.settings.tagOrder,
      tagColors: this.settings.tagColors,
      autoColorEnabled: this.settings.autoColorEnabled,
      attachmentDir: this.settings.attachmentDir,
      defaultAssignee: this.settings.defaultAssignee,
    });
    // タグ設定・添付保存先を boardStore にミラーして view を即時更新
    useBoardStore.getState().setTagConfig({
      tagOrder: this.settings.tagOrder,
      tagColors: this.settings.tagColors,
      autoColorEnabled: this.settings.autoColorEnabled,
    });
    useBoardStore.getState().setAttachmentDir(this.settings.attachmentDir);
    useBoardStore.getState().setDefaultAssignee(this.settings.defaultAssignee);
  }

  async onunload() {
    console.log("[kanban] plugin unloading...");

    this.app.workspace.detachLeavesOfType(KANBAN_VIEW_TYPE);

    try {
      this.vaultWatcher?.dispose();
    } catch (e) {
      console.warn("[kanban] vault watcher dispose failed:", e);
    }

    if (this.legacyLockToken) {
      try {
        const { LegacyKanbanDetector } = await import("./env/LegacyKanbanDetector");
        const detector = new LegacyKanbanDetector(LEGACY_KANBAN_PORT);
        const res = await detector.requestUnlock(this.legacyLockToken);
        console.log("[kanban] legacy unlock result:", res);
      } catch (e) {
        console.warn("[kanban] legacy unlock failed:", e);
      }
      this.legacyLockToken = null;
    }

    try {
      await this.processLock?.release();
    } catch (e) {
      console.warn("[kanban] process lock release failed:", e);
    }

    await this.lifecycle?.onUnload();
    console.log("[kanban] plugin unloaded.");
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(KANBAN_VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = null;
    if (existing.length > 0) {
      leaf = existing[0]!;
    } else {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: KANBAN_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  private async undoLast(): Promise<void> {
    if (!this.history || !this.taskWriter) return;
    const op = this.history.pop();
    if (!op) {
      new Notice("Nothing to undo");
      return;
    }
    try {
      // actor="undo" を渡して Journal entry で区別できるようにする (review code-reviewer#Minor 反映)
      if (op.type === "compound" && op.before.status != null && op.before.order != null) {
        await this.taskWriter.updateStatusAndOrder(
          op.filePath,
          op.afterHash,
          op.before.status,
          op.before.order,
          "undo",
        );
      } else if (op.type === "status" && op.before.status != null) {
        await this.taskWriter.updateStatus(op.filePath, op.afterHash, op.before.status, "undo");
      } else if (op.type === "order" && op.before.order != null) {
        await this.taskWriter.updateOrder(op.filePath, op.afterHash, op.before.order, "undo");
      } else if (op.type === "recurrence") {
        // 定期タスクの完了は履歴ファイル作成 + 親 due 更新の複合操作で、
        // 単純な revert が困難なため現時点では Undo 未対応。
        new Notice("Undo: 定期タスクの完了は取り消せません");
        console.warn("[kanban] undo for recurrence type is not yet supported", op);
        return;
      } else {
        new Notice("Undo: state insufficient");
        return;
      }
      new Notice("Undone");
      useBoardStore.getState().requestReload();
    } catch (e) {
      // error.message は最大 80 字に丸める (review security#Minor 反映: 情報漏洩抑制)
      const safeMsg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
      if (e instanceof ConflictError) {
        new Notice("Undo 失敗: ファイルが他で変更されています");
      } else {
        new Notice(`Undo 失敗: ${safeMsg}`);
      }
      console.error("[kanban] undo failed:", e);
      // 失敗した op は復元せず履歴から消える（複雑性回避）
    }
  }

  /**
   * Phase 6: 同じ status 内の order を 1.0, 2.0, 3.0... に振り直す手動コマンド。
   * fractional indexing で精度限界 (0.001 未満) に達した時のリセット用。
   */
  private async recompactOrder(): Promise<void> {
    if (!this.taskRepository || !this.taskWriter) {
      new Notice("Plugin not initialized");
      return;
    }
    const { tasks, errors: readErrors } = await this.taskRepository.listAll();
    if (readErrors.length > 0) {
      new Notice(`タスク読み込みで ${readErrors.length} 件のエラー。中止します。`);
      console.error("[kanban] recompact aborted, read errors:", readErrors);
      return;
    }
    const plan = planRecompactOrders(tasks);
    if (plan.length === 0) {
      new Notice("整列対象のタスクはありません");
      return;
    }
    const confirmed = window.confirm(
      `${plan.length} 件のタスクの order を整列します。続行しますか？`,
    );
    if (!confirmed) return;

    let succeeded = 0;
    let conflicted = 0;
    let failed = 0;
    for (const entry of plan) {
      try {
        await this.taskWriter.updateOrder(
          entry.filePath,
          entry.expectedHash,
          entry.newOrder,
          "migration",
        );
        succeeded += 1;
      } catch (e) {
        if (e instanceof ConflictError) {
          conflicted += 1;
        } else {
          failed += 1;
          console.error("[kanban] recompact entry failed:", entry.filePath, e);
        }
      }
    }
    const parts = [`Order 整列: ${succeeded} 件成功`];
    if (conflicted > 0) parts.push(`${conflicted} 件は他で変更されたためスキップ`);
    if (failed > 0) parts.push(`${failed} 件エラー (詳細は console)`);
    new Notice(parts.join(" / "));
    useBoardStore.getState().requestReload();
  }
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
