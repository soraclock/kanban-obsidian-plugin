import type { App, TFile } from "obsidian";
import { stringifyFile, parseFile } from "./Frontmatter";
import { PathLock } from "./PathLock";
import type { ProcessLock } from "./ProcessLock";
import { WriteJournal, type JournalEntry } from "./WriteJournal";
import { sha256 } from "./ContentHash";
import { SelfWriteTracker } from "./SelfWriteTracker";
import { isSafeRelativePath } from "./TaskWriter";
import { ensureTasksFolder } from "./EnsureTasksFolder";
import { TaskFrontmatterSchema, type Status, type Priority } from "./TaskSchema";
import { parseSubtasks } from "./Subtasks";
import type { Task } from "./Task";

const NEXT_ID_RE = /次のID:\s*\*\*K-(\d{4,})\*\*/;
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
      const m = readmeText.match(NEXT_ID_RE);
      if (!m) throw new Error("[create] _README.md の次のID が見つかりません");
      let candidateNum = parseInt(m[1]!, 10);

      const slug = this.slugify(input.title);
      let candidateId: string;
      let candidatePath: string;
      // ID プレフィックス重複を防ぐため、tasks ディレクトリ内の既存ファイル名を取得
      const listed = await this.app.vault.adapter.list(this.tasksDir);
      const existingFiles = new Set(listed.files.map((f) => f.split("/").pop()!));

      // v0.6.7: 既存ファイル全体から max ID を計算し、README の「次のID」が古ければ
      // 自動的にそれより先へ進める（他 vault からタスク移行された後、README が初期値 K-0001
      // のままになっているケースで採番衝突するバグの修正）。
      let maxExistingId = 0;
      for (const name of existingFiles) {
        const im = name.match(TASK_ID_FILE_RE);
        if (im) {
          const n = parseInt(im[1]!, 10);
          if (n > maxExistingId) maxExistingId = n;
        }
      }
      if (maxExistingId + 1 > candidateNum) {
        candidateNum = maxExistingId + 1;
      }

      let tries = 0;
      while (true) {
        candidateId = "K-" + String(candidateNum).padStart(4, "0");
        candidatePath = `${this.tasksDir}/${candidateId}-${slug}.md`;
        if (!isSafeRelativePath(candidatePath) || !candidatePath.startsWith(this.tasksDir + "/")) {
          throw new Error(`invalid create path: ${candidatePath}`);
        }
        // v0.6.7: 同一 ID 番号を持つファイルを新旧両形式（K-NNNN-*.md / K-NNNN_*.md / K-NNNN.md）
        // でまとめて検出する。`startsWith(idPrefix)` だけだと旧形式のアンダースコア区切りを
        // 衝突として拾えず、frontmatter id レベルで重複する事故が起きていた。
        const hasIdCollision = Array.from(existingFiles).some((name) => {
          const im = name.match(TASK_ID_FILE_RE);
          return im !== null && parseInt(im[1]!, 10) === candidateNum;
        });
        if (!hasIdCollision) break;
        candidateNum += 1;
        tries += 1;
        if (tries > 100) throw new Error("[create] ID 採番が 100 回連続で衝突");
      }

      const content = this.buildContent(candidateId, input);
      await this.app.vault.create(candidatePath, content);

      // README の次のID を +1 で更新。失敗時はタスクファイルを補償削除 (review #10)
      try {
        const updated = readmeText.replace(
          NEXT_ID_RE,
          `次のID: **K-${String(candidateNum + 1).padStart(4, "0")}**`,
        );
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
