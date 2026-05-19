import * as React from "react";
import { useEffect, useState } from "react";
import type { App } from "obsidian";
import { Notice, Platform } from "obsidian";
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Column } from "./Column";
import { CardView } from "./Card";
import { DetailPane } from "./DetailPane";
import { FilterBar } from "./FilterBar";
import { RecentCompletedSummary } from "./RecentCompletedSummary";
import { ListView } from "./ListView";
import { FocusView } from "./FocusView";
import { CalendarView } from "./CalendarView";
import { StatsView } from "./StatsView";
import { useBoardStore } from "../../store/boardStore";
import { STATUS_VALUES, type Status } from "../../data/TaskSchema";

/**
 * Phase 8: メインボードに表示する active な status のみ。
 * 完了 / 凍結 は CompletedView / FrozenView の専用サブビューに分離。
 * STATUS_VALUES の順序を保ったまま filter（順序保証）。
 */
const ACTIVE_STATUSES: readonly Status[] = STATUS_VALUES.filter(
  (s): s is Status => s !== "完了" && s !== "凍結",
);
import { TaskRepository } from "../../data/TaskRepository";
import type { Task } from "../../data/Task";
import { ConflictError } from "../../data/ContentHash";
import { computeAppendOrder, computeInsertOrder } from "../../data/orderCalc";
import { filterTasks } from "../../data/TaskFilter";
import type { PluginContext } from "../PluginContext";
import { dndState } from "../dndState";

/**
 * 2 段階の collision detection:
 * 1. column は **pointerWithin** で判定（pointer 直下の列が hit）。失敗時のみ rectIntersection で fallback。
 *    花木 FB「凍結列も完了と同じく直して」反映 — column も active rect 中心ではなく pointer で見るので、
 *    掴み offset で隣列が誤 hit する問題が解消する。
 * 2. その column 内の card も **pointerWithin** で判定。pointer がカード外なら closestCenter で fallback。
 *
 * 効果: 見た目（DragOverlay = pointer）と判定が完全に一致する。KeyboardSensor 経路は
 *       pointer が無いので両段とも rectIntersection / closestCenter にフォールバックする。
 */
const dragCollision: CollisionDetection = (args) => {
  const columns = args.droppableContainers.filter(
    (c) => (c.data.current as { type?: string } | undefined)?.type === "column",
  );

  // codex review #2 反映: KeyboardSensor 経路では pointer が無いので closestCenter に寄せる。
  // rectIntersection 登録順で元列が先に返り「右に動かしても元列のまま」になるのを回避。
  const isPointer = !!args.pointerCoordinates;
  let columnHits = isPointer
    ? pointerWithin({ ...args, droppableContainers: columns })
    : closestCenter({ ...args, droppableContainers: columns });
  if (columnHits.length === 0) {
    columnHits = isPointer
      ? rectIntersection({ ...args, droppableContainers: columns })
      : closestCenter({ ...args, droppableContainers: columns });
  }
  if (columnHits.length === 0) return [];

  const overColumn = columnHits[0]!;
  const overStatus = (overColumn.data?.current as { status?: string } | undefined)?.status;
  if (!overStatus) return [overColumn];

  // その column 内の card + empty placeholder のみ対象
  const dropsInColumn = args.droppableContainers.filter((c) => {
    const d = c.data.current as { type?: string; task?: { status?: string }; status?: string } | undefined;
    if (!d) return false;
    if (d.type === "card" && d.task?.status === overStatus) return true;
    if (d.type === "column" && d.status === overStatus && c.id !== overColumn.id) {
      // EmptyDropTarget (同 column type / 同 status / column 本体とは別 id)
      return true;
    }
    return false;
  });
  if (dropsInColumn.length === 0) {
    return [overColumn];
  }

  // pointer 直下のカード優先 (PointerSensor)、無ければ closestCenter (Keyboard / 余白)
  if (isPointer) {
    const pointerHits = pointerWithin({ ...args, droppableContainers: dropsInColumn });
    if (pointerHits.length > 0) return pointerHits;
  }
  const centerHits = closestCenter({ ...args, droppableContainers: dropsInColumn });
  return centerHits.length > 0 ? centerHits : [overColumn];
};

/** before/after 判定の中央付近 deadband (px)。微震動・揺れの抑制 */
const POSITION_DEADBAND_PX = 5;

/**
 * 現在の pointer Y 座標を取得する。
 * activatorEvent (PointerEvent / MouseEvent / TouchEvent) の clientY + 累積 delta.y から導出。
 * KeyboardSensor では activatorEvent に clientY が無いため null を返す。
 */
function getPointerY(event: DragEndEvent): number | null {
  const ae = event.activatorEvent as { clientY?: number } | null | undefined;
  if (ae && typeof ae.clientY === "number") {
    return ae.clientY + event.delta.y;
  }
  return null;
}

/**
 * Phase 7: status=完了 への遷移後に recurrence があれば次回 K-NNNN を自動生成する。
 * Notice で結果を通知。失敗時はエラーログのみ (元の完了処理自体は成功扱い)。
 */
async function spawnRecurrenceIfAny(ctx: PluginContext, source: Task): Promise<void> {
  const rec = source.recurrence;
  if (!rec) return;
  // idempotency: 同 recurrence + 同 title の未完了 task が既にあれば skip (二重 spawn 防止)
  const existing = useBoardStore.getState().tasks.find(
    (t) =>
      t.id !== source.id &&
      t.title === source.title &&
      t.status !== "完了" &&
      t.recurrence === rec,
  );
  if (existing) return;
  try {
    const completedAt = new Date().toISOString().slice(0, 10);
    const r = await ctx.recurrenceSpawner.spawnIfRecurring(source, completedAt);
    if (r) new Notice(`次回タスクを作成: ${r.newId} (期限 ${r.newDue})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
    new Notice(`定期タスクの次回生成に失敗: ${msg}`);
    console.error("[kanban] recurrence spawn failed:", e);
  }
}

/**
 * KeyboardSensor 経路の before/after を delta.y 方向で判定する (codex review #3 反映)。
 * - pointer がある場合は null を返し pointer 判定に任せる
 * - キーボード操作で y 方向に動きがあれば最終の delta.y 符号を採用 (見た目の上下に一致)
 * - 横方向のみの動きで y が 0 のときは null (上位 fallback に委ねる)
 */
function getKeyboardPosition(event: DragEndEvent): "before" | "after" | null {
  const ae = event.activatorEvent as { clientY?: number } | null | undefined;
  if (ae && typeof ae.clientY === "number") return null; // pointer 経路
  if (Math.abs(event.delta.y) > Math.abs(event.delta.x)) {
    if (event.delta.y > 0) return "after";
    if (event.delta.y < 0) return "before";
  }
  return null;
}

/**
 * schema audit エラーを折りたたみ式で表示。
 * デフォルトは閉じ（タイトルだけ）、タップで詳細展開。
 * モバイル画面で赤い大きな塊が画面を専有するのを避けるための圧縮表示。
 */
function ErrorBanner({ errors }: { errors: Array<{ filePath: string; message: string }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="kanban-warning-banner kanban-warning-banner--collapsible">
      <button
        type="button"
        className="kanban-warning-banner-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <strong>schema audit:</strong> {errors.length} issue(s) {expanded ? "▲" : "▼"}
      </button>
      {expanded && (
        <ul>
          {errors.slice(0, 5).map((e, i) => (
            <li key={i}>
              {e.filePath}: {e.message}
            </li>
          ))}
          {errors.length > 5 && <li>... +{errors.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

export function Board({ app, ctx }: { app: App; ctx: PluginContext }) {
  const tasks = useBoardStore((s) => s.tasks);
  const filter = useBoardStore((s) => s.filter);
  const viewMode = useBoardStore((s) => s.viewMode);
  const layoutMode = useBoardStore((s) => s.layoutMode);
  const loading = useBoardStore((s) => s.loading);
  const errors = useBoardStore((s) => s.errors);
  const reloadTrigger = useBoardStore((s) => s.reloadTrigger);
  const setTasks = useBoardStore((s) => s.setTasks);
  const setLoading = useBoardStore((s) => s.setLoading);
  const setErrors = useBoardStore((s) => s.setErrors);
  const requestReload = useBoardStore((s) => s.requestReload);

  const [activeTask, setActiveTask] = useState<Task | null>(null);
  // 花木 FB 反映: drop 後の reload で wrapper DOM が一瞬置き換わり focus が消える問題に対応。
  // 直前に移動したタスク id を保持し、tasks 更新後に同 id の wrapper へ focus を戻す。
  const focusAfterReloadRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    const id = focusAfterReloadRef.current;
    if (!id) return;
    focusAfterReloadRef.current = null;
    requestAnimationFrame(() => {
      // codex review #5 反映: id に CSS selector 特殊文字があった場合に備え CSS.escape
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
      const el = document.querySelector<HTMLElement>(
        `.kanban-card-wrapper[data-task-id="${escaped}"]`,
      );
      // preventScroll: true で同列内 reorder 時に scroll-into-view が走らないようにする
      // (走ると元の Y 位置にスクロールが戻り、視覚的に「移動していない」ように見える)
      el?.focus({ preventScroll: true });
    });
  }, [tasks, loading]);

  useEffect(() => {
    let cancelled = false;
    const repo = new TaskRepository(app, ctx.tasksDir);
    // codex review #1 反映: drop 後 reload で Loading に切り替えると DndContext が unmount され、
    // dropAnimation や focus 復帰が潰れる。既存タスクがある reload では Board を残す。
    const hadTasks = useBoardStore.getState().tasks.length > 0;
    if (!hadTasks) setLoading(true);
    repo
      .listAll()
      .then(({ tasks, errors }) => {
        if (cancelled) return;
        setTasks(tasks);
        setErrors(errors);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrors([{ filePath: "(unknown)", message: (e as Error).message }]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app, reloadTrigger, setTasks, setLoading, setErrors]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // モバイル（タッチ）: 250ms 長押し + 8px 許容で activate。
      //   指のスクロール（即発火 + 軸方向の動き）と長押しドラッグを区別するため。
      //   tolerance を超えて動いた場合は activate せずスクロールとして扱われる。
      // デスクトップ（マウス）: 8px 移動で activate（誤発火・微震動を抑える）。
      activationConstraint: Platform.isMobile
        ? { delay: 250, tolerance: 8 }
        : { distance: 8 },
    }),
    // codex review (Critical) 反映: キーボード操作対応
    // ドラッグハンドル focus → Space で持ち上げ / 矢印で移動 / Space で drop / Esc で cancel
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent): void => {
    dndState.onDragStart();
    // codex review #3 反映: 空列 placeholder などカード以外が active になった場合は無視
    const activeType = (event.active.data.current as { type?: string } | undefined)?.type;
    if (activeType !== "card") return;
    const t = tasks.find((t) => String(t.id) === String(event.active.id));
    setActiveTask(t ?? null);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    dndState.onDragEnd();
    setActiveTask(null);
    void doHandleDragEnd(event).catch((e) => {
      console.error("[kanban] handleDragEnd internal error:", e);
    });
  };

  const handleDragCancel = (): void => {
    dndState.onDragCancel();
    setActiveTask(null);
  };

  const doHandleDragEnd = async (event: DragEndEvent): Promise<void> => {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const activeTaskNow = tasks.find((t) => t.id === activeId);
    if (!activeTaskNow) return;

    const overData = over.data.current as
      | { type?: "column" | "card"; status?: Status; task?: Task }
      | undefined;

    try {
      if (overData?.type === "column") {
        const newStatus = overData.status!;
        if (activeTaskNow.status === newStatus) return;
        const newOrder = computeAppendOrder(tasks, newStatus);
        const result = await ctx.taskWriter.updateStatusAndOrder(
          activeTaskNow.filePath,
          activeTaskNow.contentHash,
          newStatus,
          newOrder,
        );
        ctx.history.push({
          type: "compound",
          filePath: activeTaskNow.filePath,
          before: { status: activeTaskNow.status, order: activeTaskNow.order },
          after: { status: newStatus, order: newOrder },
          afterHash: result.newHash,
          ts: new Date().toISOString(),
        });
        if (newStatus === "完了") {
          await spawnRecurrenceIfAny(ctx, activeTaskNow);
        }
      } else if (overData?.type === "card" && overData.task) {
        const overTask = overData.task;
        // 花木 FB 反映: 見た目 (= pointer) と判定を一致させるため、PointerSensor では
        // pointer Y を直接使って before/after を決める。active rect 中心は掴み offset で
        // ズレるため使わない。KeyboardSensor は pointer が無いので active rect で fallback。
        const overRect = event.over?.rect;
        const pointerY = getPointerY(event);
        const keyboardPosition = getKeyboardPosition(event);
        let position: "before" | "after" = "before";
        if (pointerY != null && overRect) {
          // PointerSensor 経路: pointer Y で判定 (見た目と一致)
          const overCenterY = (overRect.top + overRect.bottom) / 2;
          const diff = pointerY - overCenterY;
          if (diff > POSITION_DEADBAND_PX) position = "after";
          else if (diff < -POSITION_DEADBAND_PX) position = "before";
        } else if (keyboardPosition) {
          // KeyboardSensor 経路: 最終 delta.y 方向で判定 (矢印の方向に従う)
          position = keyboardPosition;
        } else if (overRect) {
          // 最終 fallback: active rect で判定 (translated → initial+delta)
          const translated = event.active.rect.current.translated;
          const initial = event.active.rect.current.initial;
          const activeRect = translated
            ? translated
            : initial
              ? {
                  top: initial.top + event.delta.y,
                  bottom: initial.bottom + event.delta.y,
                  left: initial.left + event.delta.x,
                  right: initial.right + event.delta.x,
                  width: initial.width,
                  height: initial.height,
                }
              : null;
          if (activeRect) {
            const activeCenterY = (activeRect.top + activeRect.bottom) / 2;
            const overCenterY = (overRect.top + overRect.bottom) / 2;
            const diff = activeCenterY - overCenterY;
            if (diff > POSITION_DEADBAND_PX) position = "after";
            else if (diff < -POSITION_DEADBAND_PX) position = "before";
          }
        }

        if (overTask.status !== activeTaskNow.status) {
          const newOrder = computeInsertOrder(tasks, overTask, activeTaskNow.id, position);
          const result = await ctx.taskWriter.updateStatusAndOrder(
            activeTaskNow.filePath,
            activeTaskNow.contentHash,
            overTask.status,
            newOrder,
          );
          if (overTask.status === "完了") {
            await spawnRecurrenceIfAny(ctx, activeTaskNow);
          }
          ctx.history.push({
            type: "compound",
            filePath: activeTaskNow.filePath,
            before: { status: activeTaskNow.status, order: activeTaskNow.order },
            after: { status: overTask.status, order: newOrder },
            afterHash: result.newHash,
            ts: new Date().toISOString(),
          });
        } else {
          // 同列内 → order 変更 (before/after で上下移動を切替)
          //
          // Phase 9 fix: 既存タスクの大半が `order: undefined` の vault では、
          // computeInsertOrder の仮想 idx fallback で算出した新 order と
          // 他タスクの sort key (undefined → 0) が乖離し、どこに drop しても
          // 必ず末尾に着地する不具合があった。
          // → 同列全体を 1, 2, 3... に renumber し、active を希望位置へ挿入する方式に
          //   切り替え。同列タスク数分の write が発生するが、order=undefined タスクは
          //   この経路で 1 回 normalize され、以後は安定する (idempotent: 既に整数なら skip)。
          const sameColumn = tasks
            .filter((t) => t.status === activeTaskNow.status)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
          const without = sameColumn.filter((t) => t.id !== activeTaskNow.id);
          const targetIdxInWithout = without.findIndex((t) => t.id === overTask.id);
          if (targetIdxInWithout < 0) return; // 想定外: over が同列に居ない
          const insertIdx =
            position === "before" ? targetIdxInWithout : targetIdxInWithout + 1;
          const newSequence: Task[] = [
            ...without.slice(0, insertIdx),
            activeTaskNow,
            ...without.slice(insertIdx),
          ];
          // 元と同じ並びなら no-op (active が既にその位置に居る)
          const isSame = newSequence.every((t, i) => t.id === sameColumn[i]?.id);
          if (isSame) return;
          // 順次 write (PathLock で直列化されるので並行発火は安全)。
          // 動かしたタスクの history.push は active についてのみ実施。
          let activeNewOrder: number | null = null;
          let activeResultHash: string | null = null;
          for (let i = 0; i < newSequence.length; i++) {
            const t = newSequence[i]!;
            const desiredOrder = i + 1;
            if (t.order === desiredOrder) continue;
            try {
              const r = await ctx.taskWriter.updateOrder(
                t.filePath,
                t.contentHash,
                desiredOrder,
              );
              if (t.id === activeTaskNow.id) {
                activeNewOrder = desiredOrder;
                activeResultHash = r.newHash;
              }
            } catch (e) {
              const safeMsg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
              console.error("[kanban] renumber write failed:", t.id, safeMsg);
              // 個別 task の失敗は許容: 残りも書き続け、最後に reload で収束
            }
          }
          if (activeNewOrder !== null && activeResultHash !== null) {
            ctx.history.push({
              type: "order",
              filePath: activeTaskNow.filePath,
              before: { order: activeTaskNow.order },
              after: { order: activeNewOrder },
              afterHash: activeResultHash,
              ts: new Date().toISOString(),
            });
          }
        }
      }
    } catch (e) {
      if (e instanceof ConflictError) {
        new Notice("ファイルが他で変更されました。リロードします。");
      } else {
        const safeMsg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`書き込み失敗: ${safeMsg}`);
        console.error("[kanban] write failed:", e);
      }
    } finally {
      // reload 後に同タスクへ focus を戻すため id を残す
      focusAfterReloadRef.current = activeId;
      requestReload();
    }
  };

  if (loading) {
    return <div className="kanban-loading">Loading...</div>;
  }

  // Phase 9: ステータス絞り込みチップが効いていれば board 表示する列もそれに従い、
  // 空の列は出さない（無音）。空配列なら active 3 列全て表示。
  const visibleStatuses: readonly Status[] =
    filter.statuses.length > 0
      ? ACTIVE_STATUSES.filter((s) => filter.statuses.includes(s))
      : ACTIVE_STATUSES;

  const errorBanner = errors.length > 0 && <ErrorBanner errors={errors} />;

  // Phase 9: layout=list / focus は DndContext を被せない（DnD 非対応の純表示モード）
  if (layoutMode === "list") {
    return (
      <>
        {errorBanner}
        <FilterBar />
        <RecentCompletedSummary tasks={tasks} />
        <ListView ctx={ctx} />
      </>
    );
  }
  if (layoutMode === "focus") {
    return (
      <>
        {errorBanner}
        <FilterBar />
        <RecentCompletedSummary tasks={tasks} />
        <FocusView ctx={ctx} />
      </>
    );
  }
  // Phase 10 (P1/P2): calendar / stats も DnD 不要 (純表示モード)
  if (layoutMode === "calendar") {
    return (
      <>
        {errorBanner}
        <FilterBar />
        <RecentCompletedSummary tasks={tasks} />
        <CalendarView ctx={ctx} />
      </>
    );
  }
  if (layoutMode === "stats") {
    return (
      <>
        {errorBanner}
        <FilterBar />
        <StatsView ctx={ctx} />
      </>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={dragCollision}
      // codex review (Major) 反映: スクリーンリーダー用の操作説明
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Space または Enter キーで持ち上げ、矢印キーで移動し、もう一度 Space または Enter でドロップします。Escape キーでキャンセルできます。",
        },
      }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {errorBanner}
      <FilterBar />
      <RecentCompletedSummary tasks={tasks} />
      <div className="kanban-board-layout">
        <div className="kanban-board">
          {visibleStatuses.map((status) => {
            const all = tasks.filter((t) => t.status === status);
            const shown = filterTasks(all, filter);
            return (
              <Column
                key={status}
                status={status}
                tasks={shown}
                totalCount={all.length}
                ctx={ctx}
              />
            );
          })}
        </div>
        <DetailPane ctx={ctx} />
      </div>
      <DragOverlay
        // codex review #5 反映: cancel / conflict 時の戻りを視認しやすくする短い animation
        dropAnimation={{ duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }}
      >
        {activeTask ? (
          // aria-hidden で screen reader の二重読み上げを防ぐ (codex review 反映)
          <div aria-hidden="true">
            <CardView task={activeTask} isOverlay compact={viewMode === "compact"} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
