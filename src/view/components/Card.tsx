import * as React from "react";
import { Notice } from "obsidian";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "../../data/Task";
import { completionRate } from "../../data/Subtasks";
import { useBoardStore } from "../../store/boardStore";
import { dndState } from "../dndState";
import { ConflictError } from "../../data/ContentHash";
import type { PluginContext } from "../PluginContext";
import { formatYmdForDisplay } from "../../util/dateFormat";
import { resolveTagColor, readableTextColor, sortByTagOrder } from "../../util/tagColor";
import { recurrenceLabel } from "../../data/Recurrence";

function CardTagList({ tags }: { tags: string[] }) {
  const tagConfig = useBoardStore((s) => s.tagConfig);
  const ordered = React.useMemo(() => sortByTagOrder(tags, tagConfig.tagOrder), [tags, tagConfig.tagOrder]);
  return (
    <div className="kanban-card-tags">
      {ordered.map((t) => {
        const color = resolveTagColor(t, tagConfig);
        const style: React.CSSProperties = color
          ? { backgroundColor: color, color: readableTextColor(color), borderColor: color }
          : {};
        return (
          <span key={t} className="kanban-tag" style={style}>
            {t}
          </span>
        );
      })}
    </div>
  );
}

function dueClassAndLabel(due: string | null | undefined): { className: string; label: string } | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDate = new Date(due + "T00:00:00");
  const diffMs = dueDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  let className = "kanban-due";
  if (diffDays < 0) className += " kanban-due-overdue";
  else if (diffDays <= 3) className += " kanban-due-soon";
  else if (diffDays <= 7) className += " kanban-due-week";
  return { className, label: formatYmdForDisplay(due) };
}

/** カード内に直接表示するサブタスクの上限件数 (超過は "+N more" 表示)。codex review 反映 */
const MAX_VISIBLE_SUBTASKS = 5;

/**
 * 純粋表示用の Card 本体。DnD ロジックを含まない。
 * Card (DnD 対応) と DragOverlay (ドラッグ中の見た目固定) の両方から呼び出される。
 *
 * Phase 8: status が active (未着手 / 進行中 / 確認待ち) のときだけ完了チェックボタンを出す。
 * onComplete は Card 経由で渡される。DragOverlay からの呼び出しでは onComplete 未指定 → ボタン非表示。
 */
export function CardView({
  task,
  isOverlay = false,
  compact = false,
  onComplete,
}: {
  task: Task;
  isOverlay?: boolean;
  /** Phase 7: 簡略表示モード (タイトル + 優先度 + 期限 + 完了率のみ) */
  compact?: boolean;
  /** Phase 8: 1 クリック完了。stopPropagation 済 onClick として呼ばれる */
  onComplete?: () => void;
}) {
  const { done, total } = completionRate(task.subtasks);
  const due = dueClassAndLabel(task.due);
  const priorityClass = `kanban-priority-${task.priority.toLowerCase()}`;
  const visibleSubs = task.subtasks.slice(0, MAX_VISIBLE_SUBTASKS);
  const hiddenSubs = task.subtasks.length - visibleSubs.length;
  const showComplete =
    !isOverlay && !!onComplete && task.status !== "完了" && task.status !== "凍結";
  return (
    <div
      className={`kanban-card ${priorityClass} ${isOverlay ? "kanban-card-overlay" : ""} ${
        compact ? "kanban-card-compact" : ""
      }`}
      data-task-id={task.id}
    >
      {showComplete && (
        <button
          type="button"
          className="kanban-card-complete"
          aria-label={
            task.status === "定期"
              ? `${task.title} の今回分を完了にする`
              : `${task.title} を完了にする`
          }
          title={task.status === "定期" ? "今回分を完了にする" : "完了にする"}
          // DnD の PointerSensor が拾わないよう pointer 系を全部 stop。
          // また Card wrapper の onClick (openDetail) も stop する。
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // wrapper への Space/Enter (drag handle) と取り合いになるので stop
            if (e.key === " " || e.key === "Enter") {
              e.stopPropagation();
              e.preventDefault();
              onComplete?.();
            }
          }}
          onClick={(e) => {
            e.stopPropagation();
            onComplete?.();
          }}
        >
          ✓
        </button>
      )}
      <div className="kanban-card-title">{task.title}</div>
      <div className="kanban-card-meta">
        <span className={`kanban-badge ${priorityClass}`}>{task.priority}</span>
        {/* v0.6.0: 定期タスクは recurrence ラベルを表示 (例: 「定期 · 毎週月曜」)。
         * recurrenceLabel が null (不正書式) なら表示しない。 */}
        {task.status === "定期" &&
          task.recurrence &&
          (() => {
            const label = recurrenceLabel(task.recurrence);
            if (!label) return null;
            return (
              <span className="kanban-card-recurrence" title={`recurrence: ${task.recurrence}`}>
                定期 · {label}
              </span>
            );
          })()}
        {due && <span className={due.className}>{due.label}</span>}
        {total > 0 && (
          <span className="kanban-subtasks">
            {done}/{total}
          </span>
        )}
      </div>
      {!compact && task.subtasks.length > 0 && (
        <ul className="kanban-card-subtasks">
          {visibleSubs.map((s, i) => (
            <li key={i} className={s.checked ? "checked" : ""}>
              <span className="kanban-subtask-check">{s.checked ? "☑" : "☐"}</span>
              <span className="kanban-subtask-text">{s.text}</span>
            </li>
          ))}
          {hiddenSubs > 0 && (
            <li className="kanban-subtask-more">+{hiddenSubs} more</li>
          )}
        </ul>
      )}
      {!compact && task.tags.length > 0 && (
        <CardTagList tags={task.tags} />
      )}
    </div>
  );
}

/**
 * カード本体（DnD ロジック付き）。
 *
 * 花木 FB 反映:
 * - ハンドル button を撤去、wrapper 全体を activator にして Tab 不要・Enter 単独で持ち上げ可能に
 * - 通常クリックと drag は PointerSensor `distance: 8` で分離（8px 動かさないと drag activate しない）
 * - Phase 3 の DetailPane open は onClick or onDoubleClick で実装する想定（drag と両立可）
 *
 * codex review 継続:
 * - useMemo で style object を毎 render 生成しない
 * - transform/transition/opacity を同一 object に統一（可読性）
 * - active 時は transform を外し opacity 0.3 のみ（DragOverlay と重ねない、掴み位置ズレ対応）
 *
 * Phase 8: 完了チェックボタンによる status=完了 遷移。
 * - updateStatus + completedAt=today を同時更新 (sanitizeFrontmatterPatch 経由)
 * - history.push で Undo 経路を確保
 * - recurrence があれば次回タスクを自動生成 (Board.handleDragEnd の挙動と一致)
 */
export function Card({ task, ctx }: { task: Task; ctx: PluginContext }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card", task },
  });
  const openDetail = useBoardStore((s) => s.openDetail);
  const viewMode = useBoardStore((s) => s.viewMode);
  const requestReload = useBoardStore((s) => s.requestReload);
  // 多重クリック防止
  const completingRef = React.useRef(false);

  const style = React.useMemo<React.CSSProperties>(
    () => ({
      transform: isDragging ? undefined : CSS.Transform.toString(transform),
      transition: isDragging ? undefined : transition,
      opacity: isDragging ? 0.3 : 1,
    }),
    [isDragging, transform, transition],
  );

  const onClick = (e: React.MouseEvent): void => {
    // ドラッグ完了直後の誤発火を抑制 (200ms ガード)
    if (dndState.shouldSuppressClick()) return;
    // 修飾キー付きクリックは Obsidian 標準の link/preview に譲る (将来の互換)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    openDetail(task.filePath);
  };

  const onComplete = React.useCallback(async (): Promise<void> => {
    if (completingRef.current) return;
    completingRef.current = true;
    try {
      const today = todayYmd();
      const beforeStatus = task.status;
      // status=定期 のタスクは「今回分を完了」モード。
      // 親（status=定期）はそのまま列に残し、履歴インスタンスを別 K-NNNN で生成して
      // 親の due を次回に更新する。
      if (task.status === "定期" && task.recurrence) {
        try {
          const r = await ctx.recurrenceSpawner.completeRecurringInstance(task, today);
          if (r) {
            new Notice(`今回分を完了。次回期限: ${r.newDue}`);
          } else {
            new Notice("定期タスクの完了処理に失敗（recurrence が不正な可能性）");
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
          new Notice(`定期タスクの完了処理に失敗: ${msg}`);
          console.error("[kanban] complete recurring failed:", e);
        }
        requestReload();
        return;
      }
      if (task.status === "定期" && !task.recurrence) {
        new Notice("この定期タスクには繰り返し設定がありません。詳細画面で設定してください。");
        return;
      }
      // 通常タスク: updateStatus で status=完了 にする (Undo 経路に乗せる)。
      const result = await ctx.taskWriter.updateStatus(
        task.filePath,
        task.contentHash,
        "完了",
      );
      ctx.history.push({
        type: "status",
        filePath: task.filePath,
        before: { status: beforeStatus },
        after: { status: "完了" },
        afterHash: result.newHash,
        ts: new Date().toISOString(),
      });
      requestReload();
    } catch (e) {
      if (e instanceof ConflictError) {
        new Notice("ファイルが他で変更されました。リロードします。");
        requestReload();
      } else {
        const safeMsg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`完了処理に失敗: ${safeMsg}`);
        console.error("[kanban] complete failed:", e);
      }
    } finally {
      completingRef.current = false;
    }
  }, [task, ctx, requestReload]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="kanban-card-wrapper"
      data-task-id={task.id}
      aria-label={`タスク ${task.title}。クリックで詳細、Space または Enter で並び替え`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <CardView
        task={task}
        compact={viewMode === "compact"}
        onComplete={() => {
          void onComplete();
        }}
      />
    </div>
  );
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
