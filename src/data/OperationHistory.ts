import type { Status } from "./TaskSchema";

export interface UndoableOp {
  type: "status" | "order" | "compound";
  filePath: string;
  /** 操作前の値 (revert で使う) */
  before: { status?: Status; order?: number };
  /** 操作後の値 */
  after: { status?: Status; order?: number };
  /** 操作後のファイル hash (revert 時の expectedHash として渡す) */
  afterHash: string;
  ts: string;
}

/**
 * Plugin 内部の Undo スタック。`Kanban: Undo Last` で 1 件 pop して revert する。
 * Obsidian 標準 undo は editor ベースで Plugin 経由の write を捕捉しないため独立運用。
 * 上限 50 件、超過時は古いものから捨てる。
 */
export class OperationHistory {
  private stack: UndoableOp[] = [];

  constructor(private readonly maxSize: number = 50) {}

  push(op: UndoableOp): void {
    this.stack.push(op);
    while (this.stack.length > this.maxSize) {
      this.stack.shift();
    }
  }

  pop(): UndoableOp | undefined {
    return this.stack.pop();
  }

  peek(): UndoableOp | undefined {
    return this.stack[this.stack.length - 1];
  }

  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  size(): number {
    return this.stack.length;
  }

  clear(): void {
    this.stack = [];
  }

  /**
   * 指定 path の操作を全て削除。
   * ファイル削除 (vault.on('delete')) や rename の追従に使う (review security#Minor 反映)。
   * @returns 削除した件数
   */
  removeByPath(filePath: string): number {
    const before = this.stack.length;
    this.stack = this.stack.filter((op) => op.filePath !== filePath);
    return before - this.stack.length;
  }
}
