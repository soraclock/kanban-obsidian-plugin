import * as React from "react";
import { Notice } from "obsidian";
import { useBoardStore } from "../../store/boardStore";
import { STATUS_VALUES, PRIORITY_VALUES, type Status, type Priority } from "../../data/TaskSchema";
import { ConflictError } from "../../data/ContentHash";
import type { Task, Subtask } from "../../data/Task";
import type { PluginContext } from "../PluginContext";
import { parseBody, buildBody, stripWikilink, wrapWikilink } from "../../data/TaskBodyFormat";
import { parseRecurrence } from "../../data/Recurrence";
import { ImageAttachments } from "./ImageAttachments";
import { formatYmdForDisplay, parseYmdInput, YMD_INPUT_REGEX } from "../../util/dateFormat";

type RecurrenceKind = "none" | "daily" | "weekly" | "monthlyDay" | "monthlyLast" | "every";
const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function specToFormParts(spec: string | null | undefined): {
  recurrenceKind: RecurrenceKind;
  recurrenceWeekday: number; // 0..6
  recurrenceMonthDayStr: string; // "1".."31" or ""
  recurrenceEveryDaysStr: string; // ">=1" or ""
} {
  const defaults = {
    recurrenceKind: "none" as RecurrenceKind,
    recurrenceWeekday: 1,
    recurrenceMonthDayStr: "1",
    recurrenceEveryDaysStr: "7",
  };
  if (!spec) return defaults;
  const r = parseRecurrence(spec);
  if (!r) return defaults;
  switch (r.kind) {
    case "daily":
      return { ...defaults, recurrenceKind: "daily" };
    case "weekly":
      return { ...defaults, recurrenceKind: "weekly", recurrenceWeekday: r.weekday };
    case "monthlyDay":
      return { ...defaults, recurrenceKind: "monthlyDay", recurrenceMonthDayStr: String(r.day) };
    case "monthlyLast":
      return { ...defaults, recurrenceKind: "monthlyLast" };
    case "every":
      return {
        ...defaults,
        recurrenceKind: "every",
        recurrenceEveryDaysStr: String(r.days),
      };
  }
}

function parseRecurrencePart(str: string, min: number, max: number, fallback: number): number {
  const n = parseInt(str, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function formPartsToSpec(parts: {
  recurrenceKind: RecurrenceKind;
  recurrenceWeekday: number;
  recurrenceMonthDayStr: string;
  recurrenceEveryDaysStr: string;
}): string | null {
  switch (parts.recurrenceKind) {
    case "none":
      return null;
    case "daily":
      return "daily";
    case "weekly":
      return `weekly:${WEEKDAY_NAMES[parts.recurrenceWeekday]!}`;
    case "monthlyDay":
      return `monthly:${parseRecurrencePart(parts.recurrenceMonthDayStr, 1, 31, 1)}`;
    case "monthlyLast":
      return "monthly:lastday";
    case "every":
      return `every:${parseRecurrencePart(parts.recurrenceEveryDaysStr, 1, 3650, 7)}d`;
  }
}

/**
 * Phase 3 DetailPane (右側ドロワー)。
 *
 * 役割:
 * - 開いている task の frontmatter + 本文を編集して保存
 * - 保存時 hash 検証 (ConflictError) → 衝突 UI で再読込 / 強制上書き / キャンセル を選択
 * - vault.on('modify') 経由で開いている task が外部編集された場合、ローカル未保存編集が
 *   無ければ自動で latest を取り込み、未保存編集があれば conflict banner を出す
 * - 凍結ボタンで status=凍結 へ遷移（凍結タブで管理）
 */
type ModelValue = "opus" | "sonnet" | "haiku" | null;
type Conflict = "external" | "save-failed" | null;

interface FormState {
  title: string;
  status: Status;
  priority: Priority;
  assignee: string;
  due: string; // YYYY-MM-DD or ""
  model: ModelValue;
  tagsCsv: string;
  // 花木 FB 反映: related は `[[xxx]]` 形式を内部処理で付け外し、UI はプレーンテキストのみ
  relatedCsv: string;
  // 本文 markdown を 3 セクションに分解した形で保持 (花木 FB「サブタスクは個別入力」)
  description: string;
  subtasks: Subtask[];
  memo: string;
  // Phase 4 リッチメタ (optional)。空欄なら null として保存
  completedAt: string; // YYYY-MM-DD or ""
  estimateHoursStr: string; // 数値 or ""
  actualHoursStr: string; // 数値 or ""
  // Phase 7 定期タスク。構造化フィールド (kind + 補助) として保持し、保存時に spec string へ変換。
  // 数値フィールドは入力中の空文字を許容するため文字列で保持する (controlled input が "1" で固定される問題を回避)。
  recurrenceKind: RecurrenceKind;
  recurrenceWeekday: number; // 0..6 (日..土)
  recurrenceMonthDayStr: string; // "1".."31" or ""
  recurrenceEveryDaysStr: string; // ">=1" or ""
}

function taskToForm(t: Task): FormState {
  const parsed = parseBody(t.bodyMarkdown);
  const tx = t as Task & {
    completedAt?: string | null;
    estimateHours?: number | null;
    actualHours?: number | null;
    recurrence?: string | null;
  };
  return {
    title: t.title,
    status: t.status,
    priority: t.priority,
    assignee: t.assignee,
    // Phase 11: 内部 YYYY-MM-DD を UI 表示用 YYYY/MM/DD に変換してフォームに渡す
    due: formatYmdForDisplay(t.due ?? ""),
    model: (t.model ?? null) as ModelValue,
    tagsCsv: t.tags.join(", "),
    relatedCsv: (t.related ?? []).map(stripWikilink).join(", "),
    description: parsed.description,
    subtasks: parsed.subtasks,
    memo: parsed.memo,
    completedAt: formatYmdForDisplay(tx.completedAt ?? ""),
    estimateHoursStr: tx.estimateHours != null ? String(tx.estimateHours) : "",
    actualHoursStr: tx.actualHours != null ? String(tx.actualHours) : "",
    ...specToFormParts(tx.recurrence),
  };
}

function formsEqual(a: FormState, b: FormState): boolean {
  return (
    a.title === b.title &&
    a.status === b.status &&
    a.priority === b.priority &&
    a.assignee === b.assignee &&
    a.due === b.due &&
    a.model === b.model &&
    a.tagsCsv === b.tagsCsv &&
    a.relatedCsv === b.relatedCsv &&
    a.description === b.description &&
    a.memo === b.memo &&
    a.completedAt === b.completedAt &&
    a.estimateHoursStr === b.estimateHoursStr &&
    a.actualHoursStr === b.actualHoursStr &&
    a.recurrenceKind === b.recurrenceKind &&
    (a.recurrenceKind !== "weekly" || a.recurrenceWeekday === b.recurrenceWeekday) &&
    (a.recurrenceKind !== "monthlyDay" || a.recurrenceMonthDayStr === b.recurrenceMonthDayStr) &&
    (a.recurrenceKind !== "every" || a.recurrenceEveryDaysStr === b.recurrenceEveryDaysStr) &&
    subtasksEqual(a.subtasks, b.subtasks)
  );
}

/** デバッグ用: form 同士の差分フィールドを抽出 (console.warn で原因特定) */
function diffFormState(a: FormState, b: FormState): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  const keys: (keyof FormState)[] = [
    "title",
    "status",
    "priority",
    "assignee",
    "due",
    "model",
    "tagsCsv",
    "relatedCsv",
    "description",
    "memo",
    "completedAt",
    "estimateHoursStr",
    "actualHoursStr",
    "recurrenceKind",
    "recurrenceWeekday",
    "recurrenceMonthDayStr",
    "recurrenceEveryDaysStr",
  ];
  for (const k of keys) {
    if (a[k] !== b[k]) out[k] = [a[k], b[k]];
  }
  if (!subtasksEqual(a.subtasks, b.subtasks)) {
    out.subtasks = [a.subtasks, b.subtasks];
  }
  return out;
}

/** "" → null、数値文字列 → number。それ以外は null。 */
function parseOptionalNonNegativeNumber(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function subtasksEqual(a: Subtask[], b: Subtask[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text || a[i]!.checked !== b[i]!.checked) return false;
  }
  return true;
}

/**
 * 3-way merge: form (ユーザー編集中) / old (編集開始時の baseline) / nextBaseline (外部編集後の最新)
 * - form[k] === old[k] → user 未編集 → nextBaseline[k] を採用
 * - form[k] !== old[k] (user 編集中):
 *   - nextBaseline[k] === old[k] (外部変更なし) → form[k] 保持
 *   - form[k] === nextBaseline[k] (偶然一致)     → form[k] 保持
 *   - 上記以外 (真の conflict)                    → form[k] 保持 + hasConflict=true
 */
export function threeWayMerge(
  form: FormState,
  old: FormState,
  nextBaseline: FormState,
): { merged: FormState; hasConflict: boolean } {
  const merged: FormState = { ...nextBaseline };
  let hasConflict = false;

  const scalarKeys: (keyof FormState)[] = [
    "title",
    "status",
    "priority",
    "assignee",
    "due",
    "model",
    "tagsCsv",
    "relatedCsv",
    "description",
    "memo",
    "completedAt",
    "estimateHoursStr",
    "actualHoursStr",
    "recurrenceKind",
    "recurrenceWeekday",
    "recurrenceMonthDayStr",
    "recurrenceEveryDaysStr",
  ];

  for (const k of scalarKeys) {
    if (form[k] !== old[k]) {
      // user が編集した
      (merged as unknown as Record<string, unknown>)[k] = form[k];
      if (nextBaseline[k] !== old[k] && form[k] !== nextBaseline[k]) {
        // 外部も変えており、かつ偶然一致でもない → 真の conflict
        hasConflict = true;
      }
    }
    // else: user 未編集 → nextBaseline 値をそのまま使う (merged は nextBaseline の spread 済み)
  }

  // subtasks は subtasksEqual で比較
  if (!subtasksEqual(form.subtasks, old.subtasks)) {
    merged.subtasks = form.subtasks;
    if (!subtasksEqual(nextBaseline.subtasks, old.subtasks) && !subtasksEqual(form.subtasks, nextBaseline.subtasks)) {
      hasConflict = true;
    }
  }

  return { merged, hasConflict };
}

function csvToList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// Phase 11: 入力は YYYY/MM/DD or YYYY-MM-DD どちらも許容、保存時に内部 YYYY-MM-DD に正規化
const DATE_INPUT_RE = YMD_INPUT_REGEX;

export function DetailPane({ ctx }: { ctx: PluginContext }) {
  const openPath = useBoardStore((s) => s.openDetailFilePath);
  const task = useBoardStore((s) =>
    openPath ? s.tasks.find((t) => t.filePath === openPath) : undefined,
  );
  const closeDetail = useBoardStore((s) => s.closeDetail);

  // form local state: openPath が変わるたびに reset
  const [form, setForm] = React.useState<FormState | null>(null);
  // 編集開始時 (or 強制 reload 時) の form snapshot と contentHash。
  // 外部編集の dirty 判定は「現在の form が baselineForm から変わったか」で行う。
  // (codex Critical 反映: 旧実装は最新 task と form の比較になっており、外部編集で常に conflict 化していた)
  const baselineFormRef = React.useRef<FormState | null>(null);
  const [baselineHash, setBaselineHash] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<Conflict>(null);
  const [saving, setSaving] = React.useState(false);
  // 「強制上書き」を選択した状態。次回保存で baselineHash を最新 hash に置換してから保存
  const [forceOverwrite, setForceOverwrite] = React.useState(false);
  // 花木 FB 反映: open 直後の React state 反映ラグと vault watcher 通知のレース対策。
  // 初期化後 300ms は conflict 判定をスキップし、最新 task で silent reload する。
  const lastInitAtRef = React.useRef<number>(0);

  // openPath が変わったら form を再初期化
  React.useEffect(() => {
    if (!task) {
      setForm(null);
      baselineFormRef.current = null;
      setBaselineHash(null);
      setConflict(null);
      setForceOverwrite(false);
      return;
    }
    const nextForm = taskToForm(task);
    setForm(nextForm);
    baselineFormRef.current = nextForm;
    setBaselineHash(task.contentHash);
    setConflict(null);
    setForceOverwrite(false);
    lastInitAtRef.current = Date.now();
    // 依存は openPath だけ (task の hash 変動はここで初期化したくない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath]);

  // store の task が外部編集で更新されたら 3-way merge を適用する。
  // - user が編集していないフィールド → 外部編集の最新値を採用
  // - user が編集中かつ外部編集もあるフィールド → user 値を保持し hasConflict=true
  // - true conflict があった場合のみ "external" バナーを出す
  React.useEffect(() => {
    if (!task || !form || !baselineHash || !baselineFormRef.current) return;
    if (task.contentHash === baselineHash) return;
    const nextBaseline = taskToForm(task);
    const sinceInit = Date.now() - lastInitAtRef.current;
    // openPath が直前に切り替わった場合は form が古いタスクの状態を保持しているので、
    // merge せず nextBaseline で完全置換する。
    // (花木 FB「カードを変えても内容が変わらない」対応)
    if (sinceInit < 300) {
      setForm(nextBaseline);
      baselineFormRef.current = nextBaseline;
      setBaselineHash(task.contentHash);
      return;
    }
    const { merged, hasConflict } = threeWayMerge(form, baselineFormRef.current, nextBaseline);
    if (hasConflict) {
      setConflict("external");
    }
    setForm(merged);
    baselineFormRef.current = nextBaseline;
    setBaselineHash(task.contentHash);
    // 編集差分が出ていた場合のみ debug 出力 (原因情報収集のため当面残す)
    if (!formsEqual(form, baselineFormRef.current)) {
      console.warn("[kanban DetailPane] external edit during local edit (3-way merge):", {
        baselineHash,
        newHash: task.contentHash,
        sinceInitMs: Date.now() - lastInitAtRef.current,
        hasConflict,
        editedFields: diffFormState(form, nextBaseline),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.contentHash]);

  if (!openPath || !task || !form) return null;

  // dirty 判定も baseline 比較に揃える (codex Minor#10 反映)
  const dirty = baselineFormRef.current ? !formsEqual(form, baselineFormRef.current) : false;

  const onSave = async (): Promise<void> => {
    if (!task) return;
    if (form.due !== "" && !DATE_INPUT_RE.test(form.due)) {
      new Notice("期限は YYYY/MM/DD 形式で入力してください");
      return;
    }
    // 定期タスクの「完了」への手動遷移は履歴が残らないため block。
    // 完了は Card 上の「今回分を完了」ボタン (✓) から行う運用に統一する。
    if (task.status === "定期" && form.status === "完了") {
      new Notice("定期タスクの完了は「今回分を完了」ボタン (✓) から行ってください");
      return;
    }
    setSaving(true);
    try {
      const expectedHash = forceOverwrite ? task.contentHash : baselineHash!;
      // codex Major-2 反映: body 部分が未編集なら bodyMarkdown を渡さない。
      // parseBody → buildBody は空行・未知 section 位置などを正規化するため、
      // 「触らず保存」で本文が canonical 化されて差分が出る問題を回避。
      const base = baselineFormRef.current!;
      const bodyDirty =
        form.description !== base.description ||
        form.memo !== base.memo ||
        !subtasksEqual(form.subtasks, base.subtasks);
      if (form.completedAt !== "" && !DATE_INPUT_RE.test(form.completedAt)) {
        new Notice("完了日は YYYY/MM/DD 形式で入力してください");
        setSaving(false);
        return;
      }
      // Phase 11: form は YYYY/MM/DD 表示、保存時に内部 YYYY-MM-DD に正規化
      const dueNormalized = form.due === "" ? null : parseYmdInput(form.due);
      const completedAtNormalized =
        form.completedAt === "" ? null : parseYmdInput(form.completedAt);
      // recurrence は GUI 入力で制約済み (バリデーション不要)
      const result = await ctx.taskWriter.updateTask(task.filePath, expectedHash, {
        frontmatter: {
          title: form.title,
          status: form.status,
          priority: form.priority,
          assignee: form.assignee,
          due: dueNormalized,
          model: form.model ?? null,
          tags: csvToList(form.tagsCsv),
          // related は plain text → `[[xxx]]` で wrap して frontmatter に保存
          related: csvToList(form.relatedCsv).map(wrapWikilink),
          completedAt: completedAtNormalized,
          estimateHours: parseOptionalNonNegativeNumber(form.estimateHoursStr),
          actualHours: parseOptionalNonNegativeNumber(form.actualHoursStr),
          recurrence: formPartsToSpec(form),
        },
        bodyMarkdown: bodyDirty
          ? buildBody({
              description: form.description,
              subtasks: form.subtasks,
              memo: form.memo,
            })
          : undefined,
      });
      setBaselineHash(result.newHash);
      // 保存成功 = 現 form が新しい baseline。次回外部編集 dirty 判定の起点に
      baselineFormRef.current = form;
      setConflict(null);
      setForceOverwrite(false);
      new Notice("保存しました");
      // VaultWatcher は SelfWriteTracker で自己 write を echo skip するため、
      // ボード側 store に反映するには書いた側（ここ）で readOne → upsertTask を呼ぶ必要がある
      try {
        const fresh = await ctx.taskRepository.readOne(task.filePath);
        if (fresh) useBoardStore.getState().upsertTask(fresh);
      } catch (e) {
        console.warn("[kanban] post-save refresh failed:", e);
      }
      // 定期タスクの履歴生成は Card 上の「今回分を完了」ボタン経由でのみ実行する。
      // DetailPane で status を「定期 → 完了」に変えた場合は普通の status 変更扱い（履歴は作らない）。
    } catch (e) {
      if (e instanceof ConflictError) {
        setConflict("save-failed");
        new Notice("保存失敗: ファイルが他で変更されました");
      } else {
        const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`保存失敗: ${msg}`);
        console.error("[kanban] DetailPane save failed:", e);
      }
    } finally {
      setSaving(false);
    }
  };

  const onFreeze = async (): Promise<void> => {
    if (!task || !baselineHash) return;
    if (dirty && !window.confirm("未保存の変更があります。変更は破棄して凍結のみ実行しますか？")) {
      return;
    }
    setSaving(true);
    try {
      const result = await ctx.taskWriter.updateStatus(
        task.filePath,
        baselineHash,
        "凍結",
      );
      ctx.history.push({
        type: "status",
        filePath: task.filePath,
        before: { status: task.status },
        after: { status: "凍結" },
        afterHash: result.newHash,
        ts: new Date().toISOString(),
      });
      new Notice("凍結に移動しました");
      try {
        const fresh = await ctx.taskRepository.readOne(task.filePath);
        if (fresh) useBoardStore.getState().upsertTask(fresh);
      } catch (e) {
        console.warn("[kanban] post-freeze refresh failed:", e);
      }
      closeDetail();
    } catch (e) {
      if (e instanceof ConflictError) {
        new Notice("凍結失敗: ファイルが他で変更されました");
        setConflict("save-failed");
      } else {
        const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`凍結失敗: ${msg}`);
        console.error("[kanban] freeze failed:", e);
      }
    } finally {
      setSaving(false);
    }
  };

  const onCancel = (): void => {
    if (dirty && !window.confirm("未保存の変更があります。閉じてもよいですか？")) return;
    closeDetail();
  };

  const onConflictReload = (): void => {
    // 最新を読み直して form リセット + baseline 再設定
    const nextForm = taskToForm(task);
    setForm(nextForm);
    baselineFormRef.current = nextForm;
    setBaselineHash(task.contentHash);
    setConflict(null);
    setForceOverwrite(false);
  };

  const onConflictForce = (): void => {
    setForceOverwrite(true);
    setConflict(null);
  };

  return (
    <aside className="kanban-detail-pane" aria-label="タスク詳細">
      <header className="kanban-detail-header">
        <h2 className="kanban-detail-title">{task.id}</h2>
        <button type="button" className="kanban-detail-close" onClick={onCancel} aria-label="閉じる">
          ×
        </button>
      </header>

      {conflict === "external" && (
        <div className="kanban-conflict-banner" role="alert">
          <strong>このファイルが他で編集されました。</strong>
          <div className="kanban-conflict-actions">
            <button type="button" onClick={onConflictReload}>
              最新を読み込む（編集破棄）
            </button>
            <button type="button" onClick={onConflictForce}>
              編集を強制上書き
            </button>
            <button type="button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        </div>
      )}
      {conflict === "save-failed" && (
        <div className="kanban-conflict-banner" role="alert">
          <strong>保存に失敗しました。ファイルが他で変更されています。</strong>
          <div className="kanban-conflict-actions">
            <button type="button" onClick={onConflictReload}>
              最新を読み込む（編集破棄）
            </button>
            <button type="button" onClick={onConflictForce}>
              編集を強制上書き
            </button>
          </div>
        </div>
      )}

      <div className="kanban-detail-form">
        <label className="kanban-field">
          <span className="kanban-field-label">タイトル</span>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>

        <div className="kanban-field-row">
          <label className="kanban-field">
            <span className="kanban-field-label">ステータス</span>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as Status })}
            >
              {STATUS_VALUES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="kanban-field">
            <span className="kanban-field-label">優先度</span>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
            >
              {PRIORITY_VALUES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="kanban-field-row">
          <label className="kanban-field">
            <span className="kanban-field-label">担当</span>
            <input
              type="text"
              value={form.assignee}
              onChange={(e) => setForm({ ...form, assignee: e.target.value })}
            />
          </label>

          <label className="kanban-field">
            <span className="kanban-field-label">期限</span>
            <input
              type="text"
              placeholder="YYYY/MM/DD（空欄可）"
              value={form.due}
              onChange={(e) => setForm({ ...form, due: e.target.value })}
            />
          </label>
        </div>

        <div className="kanban-field-row">
          <label className="kanban-field">
            <span className="kanban-field-label">完了日 (任意)</span>
            <input
              type="text"
              placeholder="YYYY/MM/DD"
              value={form.completedAt}
              onChange={(e) => setForm({ ...form, completedAt: e.target.value })}
            />
          </label>
          <label className="kanban-field">
            <span className="kanban-field-label">見積 (h)</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="例: 2.5"
              value={form.estimateHoursStr}
              onChange={(e) => setForm({ ...form, estimateHoursStr: e.target.value })}
            />
          </label>
          <label className="kanban-field">
            <span className="kanban-field-label">実績 (h)</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="例: 3"
              value={form.actualHoursStr}
              onChange={(e) => setForm({ ...form, actualHoursStr: e.target.value })}
            />
          </label>
        </div>

        <div className="kanban-field-row">
          <label className="kanban-field">
            <span className="kanban-field-label">繰り返し</span>
            <select
              value={form.recurrenceKind}
              onChange={(e) =>
                setForm({ ...form, recurrenceKind: e.target.value as RecurrenceKind })
              }
            >
              <option value="none">なし</option>
              <option value="daily">毎日</option>
              <option value="weekly">毎週○曜日</option>
              <option value="monthlyDay">毎月 N 日</option>
              <option value="monthlyLast">毎月末日</option>
              <option value="every">N 日ごと</option>
            </select>
          </label>
          {form.recurrenceKind === "weekly" && (
            <label className="kanban-field">
              <span className="kanban-field-label">曜日</span>
              <select
                value={String(form.recurrenceWeekday)}
                onChange={(e) =>
                  setForm({ ...form, recurrenceWeekday: Number(e.target.value) })
                }
              >
                {WEEKDAY_LABELS.map((label, i) => (
                  <option key={i} value={String(i)}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {form.recurrenceKind === "monthlyDay" && (
            <label className="kanban-field">
              <span className="kanban-field-label">日付 (1-31)</span>
              <input
                type="number"
                min={1}
                max={31}
                value={form.recurrenceMonthDayStr}
                onChange={(e) =>
                  setForm({ ...form, recurrenceMonthDayStr: e.target.value })
                }
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === "") {
                    setForm({ ...form, recurrenceMonthDayStr: "1" });
                  }
                }}
              />
            </label>
          )}
          {form.recurrenceKind === "every" && (
            <label className="kanban-field">
              <span className="kanban-field-label">間隔 (日)</span>
              <input
                type="number"
                min={1}
                value={form.recurrenceEveryDaysStr}
                onChange={(e) =>
                  setForm({ ...form, recurrenceEveryDaysStr: e.target.value })
                }
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v === "") {
                    setForm({ ...form, recurrenceEveryDaysStr: "7" });
                  }
                }}
              />
            </label>
          )}
        </div>

        <label className="kanban-field">
          <span className="kanban-field-label">モデル</span>
          <select
            value={form.model ?? ""}
            onChange={(e) =>
              setForm({
                ...form,
                model: e.target.value === "" ? null : (e.target.value as Exclude<ModelValue, null>),
              })
            }
          >
            <option value="">(未指定)</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
          </select>
        </label>

        <label className="kanban-field">
          <span className="kanban-field-label">タグ（カンマ区切り）</span>
          <input
            type="text"
            value={form.tagsCsv}
            onChange={(e) => setForm({ ...form, tagsCsv: e.target.value })}
          />
        </label>

        <label className="kanban-field">
          <span className="kanban-field-label">関連（カンマ区切り、`[[ ]]` 不要）</span>
          <input
            type="text"
            value={form.relatedCsv}
            placeholder="例: board, 2026年04月18日_note第1回"
            onChange={(e) => setForm({ ...form, relatedCsv: e.target.value })}
          />
        </label>

        <label className="kanban-field">
          <span className="kanban-field-label">説明 / 背景</span>
          <textarea
            rows={5}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>

        <fieldset className="kanban-field kanban-subtasks-field">
          <legend className="kanban-field-label">サブタスク</legend>
          <ul className="kanban-subtasks-list">
            {form.subtasks.map((s, i) => (
              <li key={i} className="kanban-subtask-row">
                <input
                  type="checkbox"
                  checked={s.checked}
                  aria-label={`サブタスク ${i + 1} を完了にする`}
                  onChange={(e) => {
                    const next = form.subtasks.slice();
                    next[i] = { ...next[i]!, checked: e.target.checked };
                    setForm({ ...form, subtasks: next });
                  }}
                />
                <input
                  type="text"
                  className="kanban-subtask-text-input"
                  value={s.text}
                  placeholder={`サブタスク ${i + 1}`}
                  onChange={(e) => {
                    const next = form.subtasks.slice();
                    next[i] = { ...next[i]!, text: e.target.value };
                    setForm({ ...form, subtasks: next });
                  }}
                />
                <button
                  type="button"
                  className="kanban-subtask-remove"
                  aria-label={`サブタスク ${i + 1} を削除`}
                  onClick={() => {
                    const next = form.subtasks.slice();
                    next.splice(i, 1);
                    setForm({ ...form, subtasks: next });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="kanban-subtask-add"
            onClick={() =>
              setForm({
                ...form,
                subtasks: [...form.subtasks, { text: "", checked: false }],
              })
            }
          >
            ＋ サブタスクを追加
          </button>
        </fieldset>

        <label className="kanban-field">
          <span className="kanban-field-label">メモ・備考</span>
          <textarea
            rows={6}
            value={form.memo}
            onChange={(e) => setForm({ ...form, memo: e.target.value })}
          />
        </label>

        <ImageAttachments
          app={ctx.app}
          taskId={task.id}
          bodyMarkdown={`${form.description}\n\n${form.memo}`}
          onInsert={(filename) => {
            // Phase 9: memo 末尾に `![[filename]]` を改行付きで追加。
            // 既に同名 wikilink があれば二重挿入しない。
            const tag = `![[${filename}]]`;
            if (form.memo.includes(tag) || form.description.includes(tag)) return;
            const sep = form.memo === "" ? "" : "\n\n";
            setForm({ ...form, memo: `${form.memo}${sep}${tag}` });
          }}
          onRemove={(filename) => {
            // form の各テキストフィールドから該当 wikilink (+ 前後の空行) を除去。
            // `![[name]]` と `![[name|alt]]` の両方を対象。
            const re = new RegExp(
              `\\n?!\\[\\[${filename.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\|[^\\]]*)?\\]\\]\\n?`,
              "g",
            );
            setForm({
              ...form,
              description: form.description.replace(re, ""),
              memo: form.memo.replace(re, ""),
            });
          }}
        />
      </div>

      <footer className="kanban-detail-footer">
        {task.status !== "完了" && task.status !== "凍結" && (
          <button
            type="button"
            className="kanban-detail-freeze"
            onClick={onFreeze}
            disabled={saving}
          >
            凍結に移動
          </button>
        )}
        <div className="kanban-detail-footer-right">
          <button type="button" onClick={onCancel} disabled={saving}>
            キャンセル
          </button>
          <button
            type="button"
            className="kanban-detail-save"
            onClick={onSave}
            disabled={saving || !dirty}
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </footer>
    </aside>
  );
}

