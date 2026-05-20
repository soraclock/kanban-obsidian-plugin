import * as React from "react";
import { Notice } from "obsidian";
import { CardView } from "./Card";
import type { Task } from "../../data/Task";
import { useBoardStore } from "../../store/boardStore";
import { ConflictError } from "../../data/ContentHash";
import type { PluginContext } from "../PluginContext";

/**
 * Phase 9: DnD なしのカード行。ListView / FocusView から使う。
 *
 * Card (DnD あり) と挙動を揃える:
 * - クリックで DetailPane を開く
 * - 完了チェックボタンで status=完了 に遷移 + recurrence 自動 spawn
 * - 楽観ロック (contentHash) + history.push で Undo 経路を維持
 *
 * Card.tsx 側の onComplete とロジックが重複するが、共通関数化すると DnD 経路と
 * 影響範囲が混ざるので、ここではコピーで独立性を担保する (review 反映時に
 * 1 箇所変更すれば済む規模)。
 */
export function TaskListCard({ task, ctx }: { task: Task; ctx: PluginContext }) {
  const openDetail = useBoardStore((s) => s.openDetail);
  const viewMode = useBoardStore((s) => s.viewMode);
  const requestReload = useBoardStore((s) => s.requestReload);
  const completingRef = React.useRef(false);

  const onClick = (e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    openDetail(task.filePath);
  };

  const onComplete = React.useCallback(async (): Promise<void> => {
    if (completingRef.current) return;
    completingRef.current = true;
    try {
      const today = todayYmd();
      const beforeStatus = task.status;
      // 定期タスク: 親常駐モデル → 履歴生成 + 親の due 更新 (Card.tsx と同じ分岐)
      if (task.status === "定期" && task.recurrence) {
        try {
          const r = await ctx.recurrenceSpawner.completeRecurringInstance(task, today);
          if (r) new Notice(`今回分を完了。次回期限: ${r.newDue}`);
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
      className="kanban-listcard-wrapper"
      data-task-id={task.id}
      aria-label={`タスク ${task.title}。クリックで詳細`}
      onClick={onClick}
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
