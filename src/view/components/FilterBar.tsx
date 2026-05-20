import * as React from "react";
import { Platform } from "obsidian";
import { useBoardStore, type DueFilter, type LayoutMode } from "../../store/boardStore";
import { PRIORITY_VALUES, STATUS_VALUES, type Priority, type Status } from "../../data/TaskSchema";
import { collectAllTags } from "../../data/TaskFilter";

// Phase 9: ステータス絞り込みチップ + レイアウト切替を追加（board/list/focus）。

const DUE_OPTIONS: { value: Exclude<DueFilter, null>; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "thisWeek", label: "今週" },
  { value: "overdue", label: "期限超過" },
  { value: "noDue", label: "期限なし" },
];

/**
 * Phase 9: メインボードに出すアクティブステータス。STATUS_VALUES の順序を保ったまま
 * 完了/凍結を除外。ViewTabs は board の中だけで使うのでここで定数化しても影響しない。
 */
const ACTIVE_STATUSES: readonly Status[] = STATUS_VALUES.filter(
  (s): s is Status => s !== "完了" && s !== "凍結",
);

const LAYOUT_OPTIONS: { value: LayoutMode; label: string; title: string }[] = [
  { value: "board", label: "ボード", title: "3 列のカンバン表示" },
  { value: "list", label: "リスト", title: "縦 1 列のカードリスト" },
  { value: "focus", label: "フォーカス", title: "1 ステータスだけを大きく表示" },
  { value: "calendar", label: "カレンダー", title: "期限ベースの月別カレンダー" },
  { value: "stats", label: "統計", title: "完了数推移・滞留・リードタイム" },
];

/**
 * FilterBar — ボード上部のスティッキーバー。
 * priority / statuses (Phase 9) / tags / due / 検索を全部 AND で適用 (boardStore.filter)。
 * Phase 7: 表示モード切替。Phase 9: レイアウト切替 + ステータス絞り込み。
 */
export function FilterBar() {
  const tasks = useBoardStore((s) => s.tasks);
  const filter = useBoardStore((s) => s.filter);
  const setFilter = useBoardStore((s) => s.setFilter);
  const resetFilter = useBoardStore((s) => s.resetFilter);
  const viewMode = useBoardStore((s) => s.viewMode);
  const setViewMode = useBoardStore((s) => s.setViewMode);
  const layoutMode = useBoardStore((s) => s.layoutMode);
  const setLayoutMode = useBoardStore((s) => s.setLayoutMode);
  // Phase 10 (P4): プリセット
  const savedFilters = useBoardStore((s) => s.savedFilters);
  const saveCurrentFilter = useBoardStore((s) => s.saveCurrentFilter);
  const applySavedFilter = useBoardStore((s) => s.applySavedFilter);
  const deleteSavedFilter = useBoardStore((s) => s.deleteSavedFilter);
  const [presetMenuOpen, setPresetMenuOpen] = React.useState(false);

  const allTags = React.useMemo(() => collectAllTags(tasks), [tasks]);

  // Phase 9: アクティブ 3 status の件数を 1 回の走査で取得（Board と表示が一致するよう
  // active な status だけカウント、完了/凍結はここでは数えない）
  const statusCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of ACTIVE_STATUSES) counts[s] = 0;
    for (const t of tasks) {
      if (Object.prototype.hasOwnProperty.call(counts, t.status)) {
        counts[t.status]! += 1;
      }
    }
    return counts;
  }, [tasks]);

  const togglePriority = (p: Priority): void => {
    const next = filter.priorities.includes(p)
      ? filter.priorities.filter((x) => x !== p)
      : [...filter.priorities, p];
    setFilter({ priorities: next });
  };
  const toggleStatus = (s: Status): void => {
    const next = filter.statuses.includes(s)
      ? filter.statuses.filter((x) => x !== s)
      : [...filter.statuses, s];
    setFilter({ statuses: next });
  };
  const toggleTag = (t: string): void => {
    const next = filter.tags.includes(t)
      ? filter.tags.filter((x) => x !== t)
      : [...filter.tags, t];
    setFilter({ tags: next });
  };
  const toggleDue = (d: Exclude<DueFilter, null>): void => {
    setFilter({ due: filter.due === d ? null : d });
  };

  const hasAny =
    filter.priorities.length > 0 ||
    filter.statuses.length > 0 ||
    filter.tags.length > 0 ||
    filter.due !== null ||
    filter.searchQuery.trim() !== "";

  // モバイル UI: FilterBar が画面を専有する問題を解消するため、デフォルト折りたたみ。
  // 「☰ フィルタ」ボタン + レイアウト select + 表示モード切替 の 1 行ヘッダーだけ常時表示。
  // タップで全画面オーバーレイ展開して全項目を編集できる。
  const isMobile = Platform.isMobile;
  const [mobileExpanded, setMobileExpanded] = React.useState(false);
  const appliedCount =
    filter.priorities.length +
    filter.statuses.length +
    filter.tags.length +
    (filter.due !== null ? 1 : 0) +
    (filter.searchQuery.trim() !== "" ? 1 : 0);

  // モバイル + 折りたたみ: コンパクトな 1 行ヘッダーだけ表示
  if (isMobile && !mobileExpanded) {
    return (
      <div
        className="kanban-filterbar kanban-filterbar--mobile-collapsed"
        role="region"
        aria-label="フィルタと検索（折りたたみ中）"
      >
        <button
          type="button"
          className="kanban-mobile-filter-trigger"
          onClick={() => setMobileExpanded(true)}
          aria-label="フィルタを展開"
        >
          <span className="kanban-mobile-filter-trigger-icon">☰</span>
          <span>フィルタ</span>
          {appliedCount > 0 && (
            <span className="kanban-mobile-filter-badge">{appliedCount}</span>
          )}
        </button>
        <select
          className="kanban-mobile-layout-select"
          value={layoutMode}
          onChange={(e) => setLayoutMode(e.target.value as LayoutMode)}
          aria-label="レイアウト切替"
        >
          {LAYOUT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`kanban-viewmode-toggle ${viewMode === "compact" ? "is-compact" : ""}`}
          onClick={() => setViewMode(viewMode === "compact" ? "detailed" : "compact")}
          aria-label="表示モード切替"
        >
          {viewMode === "compact" ? "簡略" : "詳細"}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`kanban-filterbar ${isMobile ? "kanban-filterbar--mobile-expanded" : ""}`}
      role="region"
      aria-label="フィルタと検索"
    >
      {isMobile && (
        <div className="kanban-mobile-filter-header">
          <button
            type="button"
            className="kanban-mobile-filter-close"
            onClick={() => setMobileExpanded(false)}
            aria-label="フィルタを閉じる"
          >
            ← 閉じる
          </button>
          <span className="kanban-mobile-filter-header-title">フィルタ</span>
          {hasAny && (
            <button
              type="button"
              className="kanban-filter-reset"
              onClick={resetFilter}
            >
              クリア
            </button>
          )}
        </div>
      )}
      <div className="kanban-filterbar-group">
        <span className="kanban-filterbar-label">ステータス</span>
        {ACTIVE_STATUSES.map((s) => {
          const active = filter.statuses.includes(s);
          const count = statusCounts[s] ?? 0;
          return (
            <button
              key={s}
              type="button"
              className={`kanban-filter-chip kanban-filter-chip-status ${
                active ? "is-active" : ""
              }`}
              onClick={() => toggleStatus(s)}
              aria-pressed={active}
              title={`${s} のタスクだけに絞り込む（再クリックで解除）`}
            >
              <span className="kanban-filter-chip-label">{s}</span>
              <span className="kanban-filter-chip-badge">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="kanban-filterbar-group">
        <span className="kanban-filterbar-label">優先度</span>
        {PRIORITY_VALUES.map((p) => (
          <button
            key={p}
            type="button"
            className={`kanban-filter-chip kanban-filter-chip-${p.toLowerCase()} ${
              filter.priorities.includes(p) ? "is-active" : ""
            }`}
            onClick={() => togglePriority(p)}
            aria-pressed={filter.priorities.includes(p)}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="kanban-filterbar-group">
        <span className="kanban-filterbar-label">期限</span>
        {DUE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`kanban-filter-chip ${filter.due === opt.value ? "is-active" : ""}`}
            onClick={() => toggleDue(opt.value)}
            aria-pressed={filter.due === opt.value}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {allTags.length > 0 && (
        <div className="kanban-filterbar-group">
          <span className="kanban-filterbar-label">タグ</span>
          {allTags.map((t) => (
            <button
              key={t}
              type="button"
              className={`kanban-filter-chip ${filter.tags.includes(t) ? "is-active" : ""}`}
              onClick={() => toggleTag(t)}
              aria-pressed={filter.tags.includes(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="kanban-filterbar-group kanban-filterbar-search">
        <input
          type="search"
          className="kanban-filter-search-input"
          placeholder="タイトル検索..."
          value={filter.searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })}
        />
        {hasAny && (
          <button
            type="button"
            className="kanban-filter-reset"
            onClick={resetFilter}
            aria-label="フィルタを全てクリア"
          >
            クリア
          </button>
        )}
        <div className="kanban-filter-preset">
          <button
            type="button"
            className="kanban-filter-preset-toggle"
            aria-haspopup="menu"
            aria-expanded={presetMenuOpen}
            onClick={() => setPresetMenuOpen((v) => !v)}
            title="保存済フィルタ"
          >
            プリセット {savedFilters.length > 0 && <span>({savedFilters.length})</span>}
          </button>
          {presetMenuOpen && (
            <div className="kanban-filter-preset-menu" role="menu">
              {savedFilters.length === 0 && (
                <div className="kanban-filter-preset-empty">保存済みなし</div>
              )}
              {savedFilters.map((f) => (
                <div key={f.id} className="kanban-filter-preset-item">
                  <button
                    type="button"
                    className="kanban-filter-preset-apply"
                    onClick={() => {
                      applySavedFilter(f.id);
                      setPresetMenuOpen(false);
                    }}
                  >
                    {f.name}
                  </button>
                  <button
                    type="button"
                    className="kanban-filter-preset-delete"
                    aria-label={`${f.name} を削除`}
                    title="削除"
                    onClick={() => {
                      if (window.confirm(`「${f.name}」を削除しますか？`)) {
                        deleteSavedFilter(f.id);
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="kanban-filter-preset-divider" />
              <button
                type="button"
                className="kanban-filter-preset-save"
                disabled={!hasAny}
                title={hasAny ? "現在のフィルタを保存" : "保存するフィルタがありません"}
                onClick={() => {
                  const name = window.prompt("プリセット名を入力");
                  if (!name) return;
                  saveCurrentFilter(name);
                  setPresetMenuOpen(false);
                }}
              >
                ＋ 現在を保存
              </button>
            </div>
          )}
        </div>
        <div className="kanban-layout-toggle" role="radiogroup" aria-label="レイアウト切替">
          {LAYOUT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={layoutMode === opt.value}
              className={`kanban-layout-toggle-btn ${
                layoutMode === opt.value ? "is-active" : ""
              }`}
              onClick={() => setLayoutMode(opt.value)}
              title={opt.title}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`kanban-viewmode-toggle ${viewMode === "compact" ? "is-compact" : ""}`}
          onClick={() => setViewMode(viewMode === "compact" ? "detailed" : "compact")}
          aria-label="表示モード切替"
          aria-pressed={viewMode === "compact"}
          title={viewMode === "compact" ? "詳細表示へ" : "簡略表示へ"}
        >
          {viewMode === "compact" ? "簡略" : "詳細"}
        </button>
      </div>
    </div>
  );
}
