import type { TaskWriter, WriteResult } from "../data/TaskWriter";
import type { TaskFrontmatter } from "../data/TaskSchema";

/**
 * Phase 5: AI 経由の write 専用ゲートウェイ。
 * 内部で TaskWriter を呼ぶが、actor を必ず "ai" 固定にする。
 * 直接 TaskWriter を AI に晒さないことで、actor を渡し忘れる事故を防ぐ。
 * 将来的に: rate limit / preview-approve / batch サポートをこのレイヤに集約。
 *
 * sessionId: AI batch で同一セッションの write をまとめる用途。
 * beginSession() / endSession() で session 中の全 write に同じ sessionId を紐付ける予定。
 * Phase 5c で TaskWriter に sessionId 引数を足す。今は AiTaskGateway 内に保持するだけ。
 */
export class AiTaskGateway {
  private currentSessionId: string | null = null;

  constructor(private readonly taskWriter: TaskWriter) {}

  /**
   * AI batch の開始を宣言し、sessionId を返す。
   * Phase 5c で TaskWriter に sessionId 引数が追加されたら、この値を渡す。
   */
  beginSession(): string {
    this.currentSessionId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return this.currentSessionId;
  }

  /** AI batch 終了。currentSessionId をクリアする。 */
  endSession(): void {
    this.currentSessionId = null;
  }

  /** 現在の sessionId を取得（Phase 5c で TaskWriter に渡す想定）。 */
  get sessionId(): string | null {
    return this.currentSessionId;
  }

  async updateTask(
    filePath: string,
    expectedHash: string,
    patch: { frontmatter?: Partial<TaskFrontmatter>; bodyMarkdown?: string },
  ): Promise<WriteResult> {
    return this.taskWriter.updateTask(filePath, expectedHash, patch, "ai");
  }

  async updateStatus(
    filePath: string,
    expectedHash: string,
    newStatus: Parameters<TaskWriter["updateStatus"]>[2],
  ): Promise<WriteResult> {
    return this.taskWriter.updateStatus(filePath, expectedHash, newStatus, "ai");
  }

  // archive / restore / updateOrder などは Phase 5c 着手時に追加。今は updateTask + updateStatus のみ。
}
