import type { App } from "obsidian";
import type { TaskWriter } from "../data/TaskWriter";
import type { TaskRepository } from "../data/TaskRepository";
import type { OperationHistory } from "../data/OperationHistory";
import type { PathLock } from "../data/PathLock";
import type { WriteJournal } from "../data/WriteJournal";
import type { RecurrenceSpawner } from "../data/RecurrenceSpawner";
import type { AiTaskGateway } from "../ai/AiTaskGateway";
import type { TaskCreator } from "../data/TaskCreator";

/**
 * View 層が必要とする Plugin 提供サービスのインターフェース。
 * KanbanView / KanbanRoot / Board の props 経由で受け渡す。
 * 循環 import を避けるため、main.ts の KanbanPlugin 本体型ではなくこの interface を使う。
 */
export interface PluginContext {
  taskWriter: TaskWriter;
  /** Phase 3: DetailPane で衝突時に単一 path を再読込するために使う */
  taskRepository: TaskRepository;
  history: OperationHistory;
  pathLock: PathLock;
  journal: WriteJournal;
  /** Phase 7: 完了状態遷移時に次回インスタンスを自動生成 */
  recurrenceSpawner: RecurrenceSpawner;
  /** Phase 5: AI 経由 write の専用ゲートウェイ。actor を必ず "ai" 固定にする */
  aiTaskGateway: AiTaskGateway;
  /** Phase 7 (タスク追加): 各列の「+」ボタンから新規タスクを作成する */
  taskCreator: TaskCreator;
  /**
   * Phase 9: Obsidian App。DetailPane の画像添付（vault.createBinary / getResourcePath）で使用。
   * 個別 service を切らずに集約 service として参照する。
   */
  app: App;
  /**
   * 設定タブで指定された tasks フォルダの vault 相対パス。
   * archive / restore / vault 内サブパス判定で view 側からも参照する。
   */
  tasksDir: string;
}
