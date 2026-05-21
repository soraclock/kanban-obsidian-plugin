import { create } from "zustand";
import type { Task } from "../data/Task";
import type { Priority, Status } from "../data/TaskSchema";

export interface BoardError {
  filePath: string;
  message: string;
}

/** Phase 6: due フィルタの 4 種 + null (= 全部) */
export type DueFilter = "today" | "thisWeek" | "overdue" | "noDue" | null;

/** Phase 7: カード表示モード */
export type ViewMode = "compact" | "detailed";

/**
 * Phase 9: メインボード内のレイアウトモード。
 * - board: 既存の 3 列横並びカンバン
 * - list:  全アクティブタスクを縦 1 列、ステータスでセクション分け
 * - focus: 1 ステータスだけ大きく表示し、上部のタブで切替
 * - calendar (Phase 10): 月別グリッドで due 別にタスクを配置
 * - stats (Phase 10): ダッシュボード/統計（完了数推移・優先度別滞留・リードタイム）
 */
export type LayoutMode = "board" | "list" | "focus" | "calendar" | "stats";

/**
 * 画面切替。
 * - board: 未着手 / 進行中 / 確認待ち の 3 列
 * - completed: status=完了 のタスクを YYYY-MM セクションで一覧
 * - frozen: status=凍結 のタスクを縦リストで一覧
 */
export type CurrentView = "board" | "completed" | "frozen";

export interface BoardFilter {
  /** 選択中の priority (複数選択 OR、空配列 = 全部) */
  priorities: Priority[];
  /**
   * Phase 9: 選択中の status (複数選択 OR、空配列 = 全部)。active 3 status のみ対象。
   * Board / List / Focus いずれのレイアウトでも適用される。
   */
  statuses: Status[];
  /** 選択中の tags (複数選択 AND、空配列 = 全部) */
  tags: string[];
  /** due フィルタ */
  due: DueFilter;
  /** 検索クエリ (タイトル部分一致、大文字小文字無視) */
  searchQuery: string;
}

/** Phase 10 (P4): 保存済フィルタプリセット */
export interface SavedFilter {
  id: string;
  name: string;
  filter: BoardFilter;
}

const SAVED_FILTERS_KEY = "kanban-saved-filters-v1";

function loadSavedFilters(): SavedFilter[] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SAVED_FILTERS_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SavedFilter =>
        x &&
        typeof x.id === "string" &&
        typeof x.name === "string" &&
        x.filter &&
        Array.isArray(x.filter.priorities) &&
        Array.isArray(x.filter.statuses) &&
        Array.isArray(x.filter.tags) &&
        typeof x.filter.searchQuery === "string",
    );
  } catch {
    return [];
  }
}

function persistSavedFilters(items: SavedFilter[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn("[kanban] persist saved filters failed:", e);
  }
}

interface BoardState {
  tasks: Task[];
  loading: boolean;
  errors: BoardError[];
  /** Plugin 外部から reload を要求するためのカウンタ。Board.tsx の useEffect が監視 */
  reloadTrigger: number;
  /** v0.4.0: タグ設定 (tagOrder / tagColors / autoColorEnabled) のミラー。
   *  設定タブが書き換えたら main.ts が setTagConfig で同期する。
   *  view 側は selector で監視して再描画する（オブジェクト参照が変わるたびに rerender）。 */
  tagConfig: {
    tagOrder: string[];
    tagColors: Record<string, string>;
    autoColorEnabled: boolean;
  };
  /** v0.5.1: 添付ファイル保存先のミラー（空文字 = kanban 既定 `<tasksDir>/_attachments`）。
   *  ImageAttachments がこれを参照して保存先を決める。 */
  attachmentDir: string;
  /** Phase 3: DetailPane で開いているタスクの filePath。null なら閉じている */
  openDetailFilePath: string | null;
  /** Phase 6: フィルタ / 検索状態 */
  filter: BoardFilter;
  /** Phase 7: カード表示モード (compact / detailed)。セッション内のみ保持 */
  viewMode: ViewMode;
  /** 現在のビュー */
  currentView: CurrentView;
  /** v0.5.0: モバイル時にタブ表示で選ばれている status。セッション内のみ。
   *  デスクトップでは未使用（4 列ボードを使う）。デフォルトは "未着手"。 */
  mobileStatusTab: Status;

  setTasks: (tasks: Task[]) => void;
  setLoading: (loading: boolean) => void;
  setErrors: (errors: BoardError[]) => void;
  /** 再読込を要求。DnD 完了後・Undo 後・vault 変更検知時 などから呼ぶ */
  requestReload: () => void;
  /** v0.4.0: 設定タブの変更を boardStore にミラーする */
  setTagConfig: (config: {
    tagOrder: string[];
    tagColors: Record<string, string>;
    autoColorEnabled: boolean;
  }) => void;
  /** v0.5.1: 添付保存先設定の同期 */
  setAttachmentDir: (dir: string) => void;
  /**
   * Phase 3: 単一 task の partial update。VaultWatcher が外部編集を検知したとき、
   * または DetailPane 保存後にロード結果をマージするときに使う。
   * 該当 filePath の task が無ければ追加、あれば置換。
   */
  upsertTask: (task: Task) => void;
  /** Phase 3: filePath の task を store から削除（ファイル削除時） */
  removeTask: (filePath: string) => void;
  /** Phase 3: DetailPane open / close */
  openDetail: (filePath: string) => void;
  closeDetail: () => void;
  /** Phase 6: filter 部分更新 + 全消去 */
  setFilter: (filter: Partial<BoardFilter>) => void;
  resetFilter: () => void;
  /** Phase 7: viewMode 切替 */
  setViewMode: (mode: ViewMode) => void;
  /** ビュー切替 */
  setCurrentView: (view: CurrentView) => void;
  /** モバイルタブ切替 */
  setMobileStatusTab: (status: Status) => void;
  /** Phase 9: ボード内レイアウトモード（board/list/focus/calendar/stats） */
  layoutMode: LayoutMode;
  /** Phase 9: layoutMode = focus のときに表示する 1 ステータス */
  focusedStatus: Status;
  /** Phase 9: レイアウト切替 */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Phase 9: focus 表示ステータス切替 */
  setFocusedStatus: (status: Status) => void;
  /** Phase 10 (P4): 保存済フィルタ一覧 */
  savedFilters: SavedFilter[];
  /** Phase 10 (P4): 現在の filter を name で保存 (同名なら上書き) */
  saveCurrentFilter: (name: string) => void;
  /** Phase 10 (P4): id 指定で保存済フィルタを適用 */
  applySavedFilter: (id: string) => void;
  /** Phase 10 (P4): id 指定で保存済フィルタを削除 */
  deleteSavedFilter: (id: string) => void;
}

const DEFAULT_FILTER: BoardFilter = {
  priorities: [],
  statuses: [],
  tags: [],
  due: null,
  searchQuery: "",
};

export const useBoardStore = create<BoardState>((set, get) => ({
  tasks: [],
  loading: false,
  errors: [],
  reloadTrigger: 0,
  tagConfig: { tagOrder: [], tagColors: {}, autoColorEnabled: true },
  attachmentDir: "",
  openDetailFilePath: null,
  filter: DEFAULT_FILTER,
  viewMode: "detailed",
  currentView: "board",
  mobileStatusTab: "未着手",
  layoutMode: "board",
  focusedStatus: "進行中",
  savedFilters: loadSavedFilters(),

  setTasks: (tasks) => set({ tasks }),
  setLoading: (loading) => set({ loading }),
  setErrors: (errors) => set({ errors }),
  requestReload: () => set((s) => ({ reloadTrigger: s.reloadTrigger + 1 })),
  setTagConfig: (config) => set({ tagConfig: config }),
  setAttachmentDir: (dir) => set({ attachmentDir: dir }),

  upsertTask: (task) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.filePath === task.filePath);
      if (idx === -1) return { tasks: [...s.tasks, task] };
      const next = s.tasks.slice();
      next[idx] = task;
      return { tasks: next };
    }),

  removeTask: (filePath) =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.filePath !== filePath),
      // Detail を開いていた場合は閉じる
      openDetailFilePath: s.openDetailFilePath === filePath ? null : s.openDetailFilePath,
    })),

  openDetail: (filePath) => set({ openDetailFilePath: filePath }),
  closeDetail: () => set({ openDetailFilePath: null }),

  setFilter: (filter) => set((s) => ({ filter: { ...s.filter, ...filter } })),
  resetFilter: () => set({ filter: DEFAULT_FILTER }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setMobileStatusTab: (status) => set({ mobileStatusTab: status }),
  setCurrentView: (view) => {
    const prev = get().currentView;
    // ビューが実際に変わるときだけ DetailPane も閉じる (同ビューのタブ再クリックで強制 close するのを避ける)。
    if (prev !== view) {
      set({ currentView: view, openDetailFilePath: null });
    } else {
      set({ currentView: view });
    }
  },
  setLayoutMode: (mode) => set({ layoutMode: mode }),
  setFocusedStatus: (status) => set({ focusedStatus: status }),

  saveCurrentFilter: (name) =>
    set((s) => {
      const trimmed = name.trim();
      if (trimmed === "") return s;
      // 同名なら上書き、なければ新規追加
      const existing = s.savedFilters.find((f) => f.name === trimmed);
      const snapshot: BoardFilter = {
        priorities: [...s.filter.priorities],
        statuses: [...s.filter.statuses],
        tags: [...s.filter.tags],
        due: s.filter.due,
        searchQuery: s.filter.searchQuery,
      };
      const next: SavedFilter[] = existing
        ? s.savedFilters.map((f) =>
            f.id === existing.id ? { ...f, filter: snapshot } : f,
          )
        : [
            ...s.savedFilters,
            {
              id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              name: trimmed,
              filter: snapshot,
            },
          ];
      persistSavedFilters(next);
      return { savedFilters: next };
    }),
  applySavedFilter: (id) =>
    set((s) => {
      const found = s.savedFilters.find((f) => f.id === id);
      if (!found) return s;
      // 完全置換 (部分更新だと残り state が残る)
      return { filter: { ...found.filter } };
    }),
  deleteSavedFilter: (id) =>
    set((s) => {
      const next = s.savedFilters.filter((f) => f.id !== id);
      persistSavedFilters(next);
      return { savedFilters: next };
    }),
}));
