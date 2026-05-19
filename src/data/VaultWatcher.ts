import type { App, EventRef, TAbstractFile, TFile, Vault } from "obsidian";
import type { TaskRepository } from "./TaskRepository";
import type { Task } from "./Task";
import { journalPathFor, lockPathFor } from "./Constants";
import type { SelfWriteTracker } from "./SelfWriteTracker";

/**
 * Phase 3: vault の外部編集 (Obsidian editor / Obsidian Sync / 他 plugin) を検知し、
 * 該当 task の store を partial update する。
 *
 * 設計:
 * - vault.on("modify" | "delete" | "rename") を購読
 * - tasksDir 配下の K-*.md のみ対象 (journal / lock / archive は除外)
 * - 同一 path への連続イベントを 100ms 単位で debounce (Obsidian Sync が短時間に複数イベント発火することがあるため)
 * - readOne で再パース → success: upsertTask / failure: removeTask
 * - dispose() で全 EventRef を offref + 保留中の debounce timer を clear
 *
 * 安全性:
 * - 全件 reload しないので、DetailPane で編集中のフォーム状態を巻き戻さない
 *   (DetailPane 側で contentHash 不一致を検知して衝突 UI を出す)
 * - store の openDetailFilePath が編集中ファイルなら upsert で contentHash が更新される
 *   → DetailPane の `lastLoadedHash` と差分でき、衝突バナーを出せる
 */
export interface VaultWatcherCallbacks {
  upsertTask: (task: Task) => void;
  removeTask: (filePath: string) => void;
  onError?: (filePath: string, message: string) => void;
}

export interface VaultWatcherOptions {
  /** debounce 時間 (ms)。テスト用に短く指定可能。既定 100ms */
  debounceMs?: number;
  /** Phase 5: self-write による echo イベントを無視するトラッカー */
  selfWriteTracker?: SelfWriteTracker;
}

const DEFAULT_DEBOUNCE_MS = 100;

export class VaultWatcher {
  private readonly debounceMs: number;
  private readonly selfWriteTracker?: SelfWriteTracker;
  private readonly vault: Vault;
  private readonly refs: EventRef[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tasksDir: string;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private disposed = false;
  private started = false;

  constructor(
    private readonly app: App,
    private readonly repo: TaskRepository,
    tasksDir: string,
    private readonly callbacks: VaultWatcherCallbacks,
    opts: VaultWatcherOptions = {},
  ) {
    this.vault = app.vault;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.selfWriteTracker = opts.selfWriteTracker;
    this.tasksDir = tasksDir;
    this.journalPath = journalPathFor(tasksDir);
    this.lockPath = lockPathFor(tasksDir);
  }

  start(): void {
    if (this.disposed) throw new Error("VaultWatcher disposed");
    // codex review#9 反映: 二重 start を no-op に。
    if (this.started) return;
    this.started = true;
    this.refs.push(
      this.vault.on("modify", (file) => this.onFileEvent(file, "modify")),
    );
    this.refs.push(
      this.vault.on("delete", (file) => this.onFileEvent(file, "delete")),
    );
    this.refs.push(
      this.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ref of this.refs) this.vault.offref(ref);
    this.refs.length = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private isTargetPath(filePath: string): boolean {
    if (filePath === this.journalPath || filePath === this.lockPath) return false;
    if (!filePath.startsWith(this.tasksDir + "/")) return false;
    if (filePath.startsWith(this.tasksDir + "/_archive/")) return false;
    const name = filePath.split("/").pop() ?? "";
    if (!name.startsWith("K-") || !name.endsWith(".md")) return false;
    return true;
  }

  private onFileEvent(file: TAbstractFile, kind: "modify" | "delete"): void {
    if (this.disposed) return;
    if (!this.isTargetPath(file.path)) return;
    if (kind === "delete") {
      this.callbacks.removeTask(file.path);
      const t = this.timers.get(file.path);
      if (t) clearTimeout(t);
      this.timers.delete(file.path);
      return;
    }
    this.scheduleReload(file.path);
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    if (this.disposed) return;
    // codex Nit 反映: 旧 path に対する debounce 中の reload が残ると、rename 後の
    // remove → 再 reload で stale な状態が出る。先に oldPath の timer を clear。
    const oldTimer = this.timers.get(oldPath);
    if (oldTimer) {
      clearTimeout(oldTimer);
      this.timers.delete(oldPath);
    }
    // 旧パスが対象なら削除、新パスが対象なら追加 (DetailPane が開いていれば store.removeTask で
    // openDetail もクリアされる仕様)
    if (this.isTargetPath(oldPath)) {
      this.callbacks.removeTask(oldPath);
    }
    if (this.isTargetPath(file.path)) {
      this.scheduleReload(file.path);
    }
  }

  private scheduleReload(filePath: string): void {
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(filePath);
      void this.reloadOne(filePath);
    }, this.debounceMs);
    this.timers.set(filePath, t);
  }

  private async reloadOne(filePath: string): Promise<void> {
    if (this.disposed) return;
    try {
      const task = await this.repo.readOne(filePath);
      if (this.disposed) return;
      if (task) {
        if (this.selfWriteTracker?.consumeIfSelf(filePath, task.contentHash)) {
          return; // 自己 write の echo なので skip
        }
        this.callbacks.upsertTask(task);
      } else {
        this.callbacks.removeTask(filePath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[kanban] VaultWatcher reload failed for ${filePath}:`, e);
      this.callbacks.onError?.(filePath, msg);
    }
  }
}

// TFile 型を明示利用していないが、上位レイヤとの整合のため re-export しておく
export type { TFile };
