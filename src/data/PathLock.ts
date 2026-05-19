/**
 * In-process per-path write キュー。
 * 同一 path への並行 write を直列化する。
 *
 * プロセス間 lock は `ProcessLock` を使う。`PathLock` は同一 Obsidian Plugin
 * インスタンス内での race を防ぐもので、責務が異なる。
 *
 * 使い方:
 *   await pathLock.with("path/to/file.md", async () => {
 *     // 排他的に実行される write 処理
 *   });
 *
 * 注意 (review code-reviewer#Major): map の delete は best-effort。
 * 後続 with が先に set した場合、古い chained は cleanup されないことがある。
 * 機能的バグではなく、ロック自体は正しく機能する。map サイズは active path 数に比例して
 * 微少に上振れする可能性があるが、長期的にも path 数 (ファイル数) で頭打ちになる。
 */
export class PathLock {
  private locks = new Map<string, Promise<void>>();

  async with<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      release = resolve;
    });
    // map には「前段が解決してから release が呼ばれるまで」を表す合成 Promise を入れる。
    // 後続の with 呼び出しは get() でこの chained を取って await する。
    // 削除判定もこの chained と参照比較する（バグ修正: 以前は releaseSignal と比較していて
    // 一致せず delete されないリーク状態だった）。
    const chained = prev.then(() => releaseSignal);
    this.locks.set(path, chained);

    try {
      await prev;
      return await fn();
    } finally {
      release();
      // microtask キュー内で chained の解決を待ってから map cleanup する
      // （他の with 呼び出しから get で参照中の可能性に配慮）
      await chained.catch(() => undefined);
      if (this.locks.get(path) === chained) {
        this.locks.delete(path);
      }
    }
  }

  isLocked(path: string): boolean {
    return this.locks.has(path);
  }

  size(): number {
    return this.locks.size;
  }
}
