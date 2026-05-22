import type { App, TFile } from "obsidian";
import { stringifyFile } from "./Frontmatter";
import { PathLock } from "./PathLock";
import type { ProcessLock } from "./ProcessLock";
import { WriteJournal, type JournalEntry } from "./WriteJournal";
import { sha256 } from "./ContentHash";
import { SelfWriteTracker } from "./SelfWriteTracker";
import { isSafeRelativePath } from "./TaskWriter";
import type { Status, Priority } from "./TaskSchema";

const NEXT_ID_RE = /次のID:\s*\*\*K-(\d{4})\*\*/;

export interface CreateTaskInput {
  title: string;
  status: Status;
  priority?: Priority; // 既定 "P2"
  assignee?: string;   // 既定 "花木"
}

export interface CreateResult {
  newId: string;
  newFilePath: string;
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

      let tries = 0;
      while (true) {
        candidateId = "K-" + String(candidateNum).padStart(4, "0");
        candidatePath = `${this.tasksDir}/${candidateId}-${slug}.md`;
        if (!isSafeRelativePath(candidatePath) || !candidatePath.startsWith(this.tasksDir + "/")) {
          throw new Error(`invalid create path: ${candidatePath}`);
        }
        // exact path 衝突 + 同一 ID プレフィックス（K-NNNN-*.md / K-NNNN.md）の衝突を両方チェック
        const idPrefix = `${candidateId}-`;
        const idExact = `${candidateId}.md`;
        const hasIdCollision = Array.from(existingFiles).some(
          (name) => name.startsWith(idPrefix) || name === idExact,
        );
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

      return { newId: candidateId, newFilePath: candidatePath };
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
      assignee: input.assignee ?? "花木",
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
