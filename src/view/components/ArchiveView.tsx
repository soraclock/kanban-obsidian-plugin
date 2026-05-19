import * as React from "react";
import { useMemo, useState } from "react";
import { Notice, type App, type TFile } from "obsidian";
import { useBoardStore } from "../../store/boardStore";
import type { PluginContext } from "../PluginContext";

/**
 * Phase 7: ボード画面と切替えるアーカイブビュー。
 * - レベル 1: 月一覧 (YYYY-MM ごとに件数)
 * - レベル 2: 選択した月のタスク一覧 + 復元ボタン
 */
interface ArchivedFile {
  path: string;
  basename: string;
  /** frontmatter.title。なければ basename にフォールバック (英語ファイル名のままにしない) */
  title: string;
  mtime: number;
  month: string; // YYYY-MM
}

function archivePrefixFor(tasksDir: string): string {
  return `${tasksDir}/_archive/`;
}

function collectArchivedFiles(app: App, tasksDir: string): ArchivedFile[] {
  const prefix = archivePrefixFor(tasksDir);
  return app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => archivedFileMeta(app, f, prefix))
    .sort((a, b) => b.mtime - a.mtime);
}

function archivedFileMeta(app: App, f: TFile, archivePrefix: string): ArchivedFile {
  const rel = f.path.slice(archivePrefix.length);
  const segs = rel.split("/");
  // 月ディレクトリ配下: "2026-05/K-xxx.md" のような形なら segs[0] が month、
  // それ以前の方式で _archive 直下にある場合は mtime から推定
  let month: string;
  if (segs.length > 1 && /^\d{4}-\d{2}$/.test(segs[0]!)) {
    month = segs[0]!;
  } else {
    const d = new Date(f.stat.mtime);
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  // frontmatter から title を取得 (metadataCache 経由、I/O なし)
  // YAML で title が配列・object に書かれているケースは typeof !== "string" で basename フォールバック（意図的）
  const cache = app.metadataCache.getFileCache(f);
  const fmTitle = cache?.frontmatter?.title;
  const title = typeof fmTitle === "string" && fmTitle.trim() !== "" ? fmTitle : f.basename;
  return { path: f.path, basename: f.basename, title, mtime: f.stat.mtime, month };
}

function groupByMonth(files: ArchivedFile[]): { month: string; count: number }[] {
  const map = new Map<string, number>();
  for (const f of files) {
    map.set(f.month, (map.get(f.month) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
}

function formatYearMonthLabel(month: string): string {
  // "2026-05" → "2026年 5月"
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return month;
  return `${m[1]}年 ${parseInt(m[2]!, 10)}月`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // Phase 11: 日付区切りを / に統一
  return `${y}/${mo}/${day} ${hh}:${mm}`;
}

export function ArchiveView({ app, ctx }: { app: App; ctx: PluginContext }) {
  const selectedMonth = useBoardStore((s) => s.archiveSelectedMonth);
  const setCurrentView = useBoardStore((s) => s.setCurrentView);
  const setArchiveSelectedMonth = useBoardStore((s) => s.setArchiveSelectedMonth);
  const reloadTrigger = useBoardStore((s) => s.reloadTrigger);
  const requestReload = useBoardStore((s) => s.requestReload);

  // _archive 配下のファイルをスキャン (reloadTrigger / 復元実行のたびに再計算)
  const [refreshCounter, setRefreshCounter] = useState(0);
  const files = useMemo(
    () => collectArchivedFiles(app, ctx.tasksDir),
    // 依存に reloadTrigger と refreshCounter を入れて再評価
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [app, ctx.tasksDir, reloadTrigger, refreshCounter],
  );

  const filesInMonth = useMemo(
    () => (selectedMonth ? files.filter((f) => f.month === selectedMonth) : []),
    [files, selectedMonth],
  );

  const onRestore = async (file: ArchivedFile): Promise<void> => {
    try {
      const r = await ctx.taskWriter.restore(file.path, ctx.tasksDir);
      new Notice(`復元しました: ${r.restoredPath.split("/").pop()}`);
      setRefreshCounter((n) => n + 1);
      requestReload();
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
      new Notice(`復元失敗: ${msg}`);
      console.error("[kanban] restore failed:", e);
    }
  };

  // 月一覧 (selectedMonth === null)
  if (selectedMonth === null) {
    const months = groupByMonth(files);
    return (
      <div className="kanban-archive-view">
        <header className="kanban-archive-header">
          <button
            type="button"
            className="kanban-archive-back"
            onClick={() => setCurrentView("board")}
          >
            ← カンバンへ戻る
          </button>
          <h2 className="kanban-archive-h2">アーカイブ</h2>
        </header>
        {months.length === 0 ? (
          <p className="kanban-archive-empty">アーカイブはまだありません。</p>
        ) : (
          <div className="kanban-archive-months">
            {months.map(({ month, count }) => (
              <button
                key={month}
                type="button"
                className="kanban-archive-month-card"
                onClick={() => setArchiveSelectedMonth(month)}
              >
                <span className="kanban-archive-month-label">{formatYearMonthLabel(month)}</span>
                <span className="kanban-archive-month-count">{count} 件</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // 月内タスク一覧 (selectedMonth が設定されている)
  return (
    <div className="kanban-archive-view">
      <header className="kanban-archive-header">
        <button
          type="button"
          className="kanban-archive-back"
          onClick={() => setArchiveSelectedMonth(null)}
        >
          ← 月一覧へ
        </button>
        <h2 className="kanban-archive-h2">アーカイブ {formatYearMonthLabel(selectedMonth)}</h2>
        <button
          type="button"
          className="kanban-archive-back-board"
          onClick={() => setCurrentView("board")}
        >
          カンバンへ
        </button>
      </header>
      {filesInMonth.length === 0 ? (
        <p className="kanban-archive-empty">この月のアーカイブはありません。</p>
      ) : (
        <div className="kanban-archive-list">
          {filesInMonth.map((f) => (
            <div key={f.path} className="kanban-archive-row">
              <div className="kanban-archive-main">
                <div className="kanban-archive-title" title={f.basename}>{f.title}</div>
                <div className="kanban-archive-meta">
                  <span className="kanban-archive-date">{formatDateTime(f.mtime)}</span>
                </div>
              </div>
              <div className="kanban-archive-actions">
                <button
                  type="button"
                  className="mod-cta"
                  onClick={() => {
                    void onRestore(f);
                  }}
                >
                  復元
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
