import type { App, TFile } from "obsidian";
import { stringifyFile, parseFile } from "./Frontmatter";
import { PathLock } from "./PathLock";
import type { ProcessLock } from "./ProcessLock";
import { WriteJournal, type JournalEntry } from "./WriteJournal";
import { sha256 } from "./ContentHash";
import { SelfWriteTracker } from "./SelfWriteTracker";
import { isSafeRelativePath } from "./TaskWriter";
import { ensureTasksFolder, upsertReadmeNextId } from "./EnsureTasksFolder";
import { TaskFrontmatterSchema, type Status, type Priority } from "./TaskSchema";
import { parseSubtasks } from "./Subtasks";
import type { Task } from "./Task";

/**
 * 既存タスクファイル名から K-NNNN を抽出する正規表現。
 * - 新形式: `K-0001-foo.md` (ハイフン + slug)
 * - 旧形式 / 移行形式: `K-0001_foo.md` (アンダースコア + タイトル)
 * - 拡張子直前で終わる: `K-0001.md`
 * v0.6.7: 旧形式の vault からタスク移行されたケースで採番衝突 / max ID 取りこぼしを防ぐ。
 * v0.6.9: 4 桁固定だと K-10000 以降が抽出できないため `\d{4,}` で 4 桁以上を許容。
 */
const TASK_ID_FILE_RE = /^K-(\d{4,})(?:[-_].*)?\.md$/;

export interface CreateTaskInput {
  title: string;
  status: Status;
  priority?: Priority; // 既定 "P2"
  /**
   * 担当者。未指定なら TaskCreator にコンストラクタ注入された getDefaultAssignee の戻り値を使う。
   * v0.6.6 で旧ハードコード「花木」を撤去（公開プラグインなのでユーザー設定値を参照）。
   */
  assignee?: string;
}

export interface CreateResult {
  newId: string;
  newFilePath: string;
  /** vault.create 直後に content から構築した Task。vault/metadata API を経由しないため
   * Obsidian/iCloud/mobile での metadata 追従遅延に関わらず即時にボードへ反映できる。 */
  createdTask: Task;
}

/**
 * Phase 7: 新規タスク作成。
 * 各列の「+」ボタンから呼ばれる。タイトル + status 必須、他は既定値。
 * - `_README.md` の「次のID: K-NNNN」を採番 → +1 書き戻し
 * - frontmatter: テンプレ準拠（completedAt / estimateHours / actualHours / recurrence は null）
 * - body: テンプレ準拠（## 背景 / ## 次のアクション / ## メモ の空セクション）
 * - slug: タイトル冒頭 24 文字を kebab 化（許可外文字は `-`）
 * - 衝突: ID 採番 + slug で path 衝突なら ID +1 で再採番（最大 100 回）
 */
export class TaskCreator {
  constructor(
    private readonly app: App,
    private readonly tasksDir: string,
    private readonly pathLock: PathLock,
    private readonly journal: WriteJournal,
    private readonly selfWriteTracker?: SelfWriteTracker,
    private readonly isWriteAllowed?: () => boolean,
    private readonly processLock?: ProcessLock,
    /**
     * v0.6.6: 既定 assignee を Plugin 設定から取得する getter。
     * 呼び出し時点の最新値を読むためコンストラクタで関数を受ける（設定変更後も再注入不要）。
     * 未注入 / 空文字なら frontmatter の assignee は空文字になる。
     */
    private readonly getDefaultAssignee?: () => string,
  ) {}

  private async withProcessLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.processLock) return fn();
    const acquired = await this.processLock.acquire();
    if (!acquired) {
      throw new Error("createTask rejected: failed to acquire ProcessLock (timeout)");
    }
    try {
      return await fn();
    } finally {
      await this.processLock.release();
    }
  }

  async createTask(
    input: CreateTaskInput,
    actor: JournalEntry["actor"] = "user",
  ): Promise<CreateResult> {
    if (this.isWriteAllowed && !this.isWriteAllowed()) {
      throw new Error("write rejected: plugin is in readOnly mode (EnvironmentGate)");
    }
    if (!input.title || input.title.trim() === "") {
      throw new Error("title is required");
    }
    return this.withProcessLock(async () => {
    // 新規 vault / iCloud で _README.md が無い場合に自動生成（race は ProcessLock で直列化）
    await ensureTasksFolder(this.app, this.tasksDir);

    const readmePath = `${this.tasksDir}/_README.md`;
    return this.pathLock.with(readmePath, async () => {
      const readmeFile = this.getTFile(readmePath);
      const readmeText = await this.app.vault.read(readmeFile);

      const slug = this.slugify(input.title);
      let candidateId: string;
      let candidatePath: string;

      // 案A (v0.6.13): 採番の真実は README カウンタではなく「実在タスクファイルの最大 ID + 1」。
      // 配布先ユーザーが README を知らずにタスクを削除・編集しても throw せず採番でき、
      // 削除後の ID 欠番でも止まらない（従来は README 行が読めないと createTask が失敗していた）。
      // adapter.list は top-level しか見ず _archive を取りこぼすため、tasksDir 配下を
      // 再帰的に走査する getMarkdownFiles() を使い、アーカイブ済みタスクとも ID 衝突させない。
      const { maxId, ids } = this.scanTaskIds();
      let candidateNum = maxId + 1;

      let tries = 0;
      while (true) {
        candidateId = "K-" + String(candidateNum).padStart(4, "0");
        candidatePath = `${this.tasksDir}/${candidateId}-${slug}.md`;
        if (!isSafeRelativePath(candidatePath) || !candidatePath.startsWith(this.tasksDir + "/")) {
          throw new Error(`invalid create path: ${candidatePath}`);
        }
        if (!ids.has(candidateNum)) break;
        candidateNum += 1;
        tries += 1;
        if (tries > 100) throw new Error("[create] ID 採番が 100 回連続で衝突");
      }

      const content = this.buildContent(candidateId, input);
      await this.app.vault.create(candidatePath, content);

      // README の「次のID」を +1 で更新（行が壊れ/欠落していれば挿入して自己修復）。
      // 失敗時はタスクファイルを補償削除 (review #10)
      try {
        const updated = upsertReadmeNextId(readmeText, candidateNum + 1);
        await this.app.vault.modify(readmeFile, updated);
      } catch (readmeErr) {
        // 補償削除: ID カウンタが進まなかったので、作成済みタスクファイルを削除して ID 重複を防ぐ
        try {
          const created = this.app.vault.getAbstractFileByPath(candidatePath);
          if (created && "stat" in created) {
            await this.app.vault.delete(created as TFile);
          }
        } catch (cleanupErr) {
          console.error("[kanban] task rollback failed:", candidatePath, cleanupErr);
        }
        await this.journal.append({
          ts: new Date().toISOString(),
          op: "createTask",
          path: candidatePath,
          beforeHash: "",
          afterHash: "",
          actor,
          approved: false,
          beforeData: undefined,
          afterData: { id: candidateId, title: input.title, status: input.status, rollback: "readme_update_failed" },
        });
        throw readmeErr;
      }

      const afterHash = sha256(content);
      await this.journal.append({
        ts: new Date().toISOString(),
        op: "createTask",
        path: candidatePath,
        beforeHash: "",
        afterHash,
        actor,
        approved: true,
        beforeData: undefined,
        afterData: { id: candidateId, title: input.title, status: input.status },
      });

      // VaultWatcher の echo 抑制（任意）
      this.selfWriteTracker?.markSelf(candidatePath, afterHash);

      // content から直接 Task を構築（vault.read / metadataCache を経由しない）
      const parsedContent = parseFile(content);
      const fmResult = TaskFrontmatterSchema.safeParse(parsedContent.data);
      if (!fmResult.success) {
        throw new Error(`[create] internal: content schema invalid: ${fmResult.error.message}`);
      }
      const createdTask: Task = {
        ...fmResult.data,
        filePath: candidatePath,
        contentHash: afterHash,
        bodyMarkdown: parsedContent.content,
        subtasks: parseSubtasks(parsedContent.content),
      };

      return { newId: candidateId, newFilePath: candidatePath, createdTask };
    });
    }); // withProcessLock
  }

  /**
   * tasksDir 配下（サブフォルダ _archive 含む）の全 K-NNNN を走査し、最大 ID 番号と
   * 既存 ID 番号の集合を返す。案A の採番（実ファイル最大 +1）と衝突回避に使う。
   *
   * 新旧両形式（K-NNNN-*.md / K-NNNN_*.md / K-NNNN.md）を TASK_ID_FILE_RE でまとめて拾う。
   * adapter.list（top-level のみ）ではなく getMarkdownFiles() を使うことで、_archive 配下に
   * 退避したタスクの ID も最大値・衝突判定に含め、アーカイブ済みタスクとの ID 重複を防ぐ。
   */
  private scanTaskIds(): { maxId: number; ids: Set<number> } {
    const ids = new Set<number>();
    let maxId = 0;
    const prefix = this.tasksDir + "/";
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (!f.path.startsWith(prefix)) continue;
      const name = f.path.split("/").pop() ?? "";
      const im = name.match(TASK_ID_FILE_RE);
      if (!im) continue;
      const n = parseInt(im[1]!, 10);
      ids.add(n);
      if (n > maxId) maxId = n;
    }
    return { maxId, ids };
  }

  private slugify(title: string): string {
    // コードポイント単位で 24 文字スライス (サロゲートペアの分割回避)
    const head = [...title].slice(0, 24).join("");
    return (
      head
        .replace(/[^A-Za-z0-9_\-ぁ-んァ-ヶ一-龥]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "untitled"
    );
  }

  private buildContent(newId: string, input: CreateTaskInput): string {
    const today = ymdLocal(new Date());
    const data: Record<string, unknown> = {
      id: newId,
      title: input.title.trim(),
      status: input.status,
      assignee: input.assignee ?? this.getDefaultAssignee?.() ?? "",
      priority: input.priority ?? "P2",
      due: null,
      model: null,
      created: today,
      updated: today,
      tags: [],
      related: [],
      completedAt: null,
      estimateHours: null,
      actualHours: null,
      recurrence: null,
    };
    const body = "\n## 背景\n\n## 次のアクション\n- [ ] \n\n## メモ\n";
    return stringifyFile(body, data);
  }

  private getTFile(filePath: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file) throw new Error(`file not found: ${filePath}`);
    if (!("stat" in file)) throw new Error(`not a file: ${filePath}`);
    return file as TFile;
  }
}

function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
