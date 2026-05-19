/**
 * Phase 5: self-write 検知器。
 * TaskWriter が書き込んだ直後の (path, afterHash) を一時保持し、
 * VaultWatcher が同 hash の modify を検知した時 ignore する。
 * 同じ path に対して別の hash が来ればそれは外部編集なので素通り。
 *
 * AI batch (10 件連続 write) で reload が連発する問題への備え。
 * Set で保持するのは同一 path への複数連続 write に対応するため。
 */
export class SelfWriteTracker {
  /** path → 直前に self-write した afterHash の Set (短時間内に複数 write することがあるので Set) */
  private readonly recent = new Map<string, Set<string>>();
  /** 自己クリア用 TTL (ms)。短時間で expire させて metadataCache の遅延 modify だけを吸収 */
  private readonly ttlMs: number;

  constructor(ttlMs = 5000) {
    this.ttlMs = ttlMs;
  }

  markSelf(path: string, afterHash: string): void {
    if (!this.recent.has(path)) this.recent.set(path, new Set());
    this.recent.get(path)!.add(afterHash);
    setTimeout(() => {
      const set = this.recent.get(path);
      if (!set) return;
      set.delete(afterHash);
      if (set.size === 0) this.recent.delete(path);
    }, this.ttlMs);
  }

  /** 該当 (path, hash) が self-write 由来なら true (= ignore すべき)。一度 consume したら remove */
  consumeIfSelf(path: string, hash: string): boolean {
    const set = this.recent.get(path);
    if (!set || !set.has(hash)) return false;
    set.delete(hash);
    if (set.size === 0) this.recent.delete(path);
    return true;
  }
}
