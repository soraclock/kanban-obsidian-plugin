import * as React from "react";
import { useState } from "react";
import { Notice } from "obsidian";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { Card } from "./Card";
import type { Task, Status } from "../../data/Task";
import { useBoardStore } from "../../store/boardStore";
import type { PluginContext } from "../PluginContext";

/**
 * 空列の droppable プレースホルダー。
 * - 空列でも pointer/collision で確実に拾えるよう独立 droppable にする
 * - codex review #3 反映: useSortable で SortableContext items の一員にし、
 *   keyboard 矢印移動でも空列に到達できるようにする。`disabled: { draggable: true }` で
 *   placeholder 自身がドラッグ対象になるのは防ぐ。
 * - 見た目はカード本体 (.kanban-card) と同じ box model でベースライン揃え
 * - id は `empty-${status}`、data.type は "column" (Board.tsx の dragCollision で列 hit と同じ扱い)
 */
function EmptyDropTarget({ status }: { status: Status }) {
  const { setNodeRef, isOver } = useSortable({
    id: `empty-${status}`,
    data: { type: "column", status },
    disabled: { draggable: true },
  });
  return (
    <div
      ref={setNodeRef}
      className={`kanban-card kanban-empty-card ${isOver ? "kanban-empty-over" : ""}`}
    >
      (空)
    </div>
  );
}

export function Column({
  status,
  tasks,
  totalCount,
  ctx,
}: {
  status: Status;
  tasks: Task[];
  /** Phase 6: フィルタ適用前のこの status の全件数。フィルタ中は "shown/total" 表示 */
  totalCount?: number;
  /** Phase 7 (タスク追加): 新規タスク作成に使う */
  ctx: PluginContext;
}) {
  const sorted = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${status}`,
    data: { type: "column", status },
  });
  const showFilteredCount = totalCount !== undefined && totalCount !== tasks.length;

  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  // stale closure 対策: onChange と確定処理の両方で同期した値を読むため ref も保持
  const newTitleRef = React.useRef("");
  /** subscribe の unsub を unmount cleanup で呼ぶための ref */
  const unsubRef = React.useRef<(() => void) | null>(null);
  const openDetail = useBoardStore((s) => s.openDetail);
  const requestReload = useBoardStore((s) => s.requestReload);

  // unmount 時に残存 subscribe を解除
  React.useEffect(() => () => { unsubRef.current?.(); }, []);

  const onConfirm = async (): Promise<void> => {
    const title = newTitleRef.current.trim();
    if (title === "") {
      setCreating(false);
      setNewTitle("");
      newTitleRef.current = "";
      return;
    }
    try {
      const r = await ctx.taskCreator.createTask({ title, status });
      new Notice(`作成しました: ${r.newId}`);
      setCreating(false);
      setNewTitle("");
      newTitleRef.current = "";
      // VaultWatcher は SelfWriteTracker で自己 write を echo skip するため、
      // 書いた側で readOne → upsertTask を呼んでボード即時反映する
      let fresh: Awaited<ReturnType<typeof ctx.taskRepository.readOne>> = null;
      try {
        fresh = await ctx.taskRepository.readOne(r.newFilePath);
        if (fresh) useBoardStore.getState().upsertTask(fresh);
      } catch (e) {
        console.warn("[kanban] post-create refresh failed:", e);
      }
      if (fresh) {
        // upsert 成功 → DetailPane を即開く（subscribe / requestReload は不要）
        openDetail(r.newFilePath);
      } else {
        // フォールバック: readOne が null（metadataCache 未追従等）の時のみ requestReload + subscribe
        requestReload();
        let opened = false;
        unsubRef.current = useBoardStore.subscribe((s) => {
          if (opened) return;
          if (s.tasks.find((t) => t.filePath === r.newFilePath)) {
            opened = true;
            unsubRef.current?.();
            unsubRef.current = null;
            openDetail(r.newFilePath);
          }
        });
        setTimeout(() => {
          if (!opened) {
            opened = true;
            unsubRef.current?.();
            unsubRef.current = null;
          }
        }, 2000);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
      new Notice(`作成失敗: ${msg}`);
      console.error("[kanban] create task failed:", e);
      setCreating(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      className={`kanban-column ${isOver ? "kanban-column-over" : ""}`}
      data-status={status}
    >
      <div className="kanban-column-header">
        <span className="kanban-column-title">{status}</span>
        <span className="kanban-column-count">
          {showFilteredCount ? `${tasks.length}/${totalCount}` : tasks.length}
        </span>
        {/* #5: creating 中は disabled にして二重クリックを防ぐ */}
        <button
          type="button"
          className="kanban-column-add"
          aria-label={`${status} に新規タスク追加`}
          title="新規タスクを追加"
          disabled={creating}
          onClick={() => setCreating(true)}
        >
          +
        </button>
      </div>
      <SortableContext
        items={sorted.length === 0 ? [`empty-${status}`] : sorted.map((t) => t.filePath)}
        strategy={verticalListSortingStrategy}
      >
        <div className="kanban-column-body">
          {creating && (
            <div className="kanban-column-new">
              <input
                type="text"
                autoFocus
                className="kanban-column-new-input"
                placeholder="新規タスクのタイトル..."
                value={newTitle}
                onChange={(e) => {
                  setNewTitle(e.target.value);
                  newTitleRef.current = e.target.value;
                }}
                onKeyDown={(e) => {
                  // Enter での自動確定は廃止。入力中の誤発火を防ぐため、明示的に
                  // 右の ✓ ボタンクリックでのみ作成する。Escape はキャンセルのまま維持。
                  if (e.key === "Escape") {
                    setCreating(false);
                    setNewTitle("");
                    newTitleRef.current = "";
                  }
                }}
              />
              <button
                type="button"
                className="kanban-column-new-confirm"
                aria-label="このタスクを作成"
                title="作成"
                disabled={newTitle.trim() === ""}
                onMouseDown={(e) => {
                  // モバイルでソフトキーボードを閉じさせない / focus loss 抑止
                  e.preventDefault();
                }}
                onClick={() => {
                  void onConfirm();
                }}
              >
                ✓
              </button>
              <button
                type="button"
                className="kanban-column-new-cancel"
                aria-label="キャンセル"
                title="キャンセル"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setCreating(false);
                  setNewTitle("");
                  newTitleRef.current = "";
                }}
              >
                ×
              </button>
            </div>
          )}
          {sorted.length === 0 ? (
            <EmptyDropTarget status={status} />
          ) : (
            sorted.map((t) => <Card key={t.filePath} task={t} ctx={ctx} />)
          )}
        </div>
      </SortableContext>
    </div>
  );
}
