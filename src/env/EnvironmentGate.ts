import type { App } from "obsidian";
import { LegacyKanbanDetector } from "./LegacyKanbanDetector";
import { SchemaAudit } from "../data/SchemaAudit";
import { ProcessLock } from "../data/ProcessLock";
import type { GateMode, GateResult } from "../lifecycle/PluginLifecycle";
import * as fs from "fs";
import * as path from "path";

export interface EnvironmentGateOptions {
  legacyKanbanPort: number;
  processLock: ProcessLock;
  tasksDir: string;
  /** バックアップ存在チェックの対象ディレクトリ（既定は `${tasksDir}/_archive`） */
  backupDir?: string;
  /** バックアップ最終ファイルが何日以上前なら warn にするか（既定 7） */
  backupMaxAgeDays?: number;
}

const DEFAULT_BACKUP_MAX_AGE_DAYS = 7;

export class EnvironmentGate {
  private mode: GateMode = "normal";

  constructor(
    private readonly app: App,
    private readonly opts: EnvironmentGateOptions,
  ) {}

  /**
   * readOnly 状態でないとき true を返す。
   * TaskWriter の write guard で使用する。
   */
  isWriteAllowed(): boolean {
    return this.mode !== "readOnly";
  }

  /**
   * 戻り値の `legacyLockToken` は L1 で旧 Hono の lock を取った場合のみ非 null。
   * Plugin の onunload で `LegacyKanbanDetector.requestUnlock(token)` に渡す。
   */
  async check(): Promise<GateResult & { legacyLockToken: string | null }> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // L1: 旧 kanban 検知 + 自動 lock POST
    const legacyLockToken = await this.checkL1Legacy(warnings, errors);

    // L1 で error が出た場合（旧 kanban が止められない）、L3/L4 をスキップする。
    // 旧 Hono が write 可能なまま audit を走らせると結果が不安定になるため。
    // review#Medium1 反映。
    if (errors.length > 0) {
      warnings.push("L1 failure: skipping L3 audit and L4 backup check (audit result would be unreliable)");
      this.mode = "readOnly";
      return { mode: "readOnly", warnings, errors, legacyLockToken };
    }

    // L2: lock ファイル検査
    await this.checkL2LockFile(warnings, errors);

    // L3: schema audit
    await this.checkL3SchemaAudit(warnings, errors);

    // L4: バックアップ整合
    await this.checkL4Backup(warnings);

    // L5: lifecycle 検査は PluginLifecycle.onLoad 側で実施済み（hot reload detach）

    const mode: GateMode = errors.length > 0 ? "readOnly" : "normal";
    this.mode = mode;
    return { mode, warnings, errors, legacyLockToken };
  }

  // --- L1 --- 旧 kanban 検知 + auto-lock。成功時は token を返す（unlock 用）
  private async checkL1Legacy(warnings: string[], errors: string[]): Promise<string | null> {
    const detector = new LegacyKanbanDetector(this.opts.legacyKanbanPort);
    const detect = await detector.detect();
    if (!detect.running) return null;

    const lockRes = await detector.requestLock();
    if (lockRes.ok) {
      warnings.push(
        `L1: legacy kanban detected on port ${this.opts.legacyKanbanPort} -> auto-locked via /api/admin/lock`,
      );
      return lockRes.token ?? null;
    } else {
      errors.push(
        `L1: legacy kanban running on port ${this.opts.legacyKanbanPort} but auto-lock failed (status=${lockRes.status ?? "n/a"}, reason=${lockRes.reason ?? "n/a"}). 旧 kanban を停止してください。`,
      );
      return null;
    }
  }

  // --- L2 --- .kanban-lock 多重起動検知
  private async checkL2LockFile(warnings: string[], _errors: string[]): Promise<void> {
    const rel = this.opts.tasksDir + "/.kanban-lock";
    const exists = await this.app.vault.adapter.exists(rel);
    if (!exists) return;

    // 既存 lock を読んで stale か確認
    try {
      const raw = await this.app.vault.adapter.read(rel);
      const data = JSON.parse(raw) as {
        uuid: string;
        owner: string;
        createdAt: string;
        ttlSeconds: number;
        pid: number;
      };
      const ageMs = Date.now() - Date.parse(data.createdAt);
      const ttlMs = data.ttlSeconds * 1000;
      if (ageMs > ttlMs) {
        warnings.push(
          `L2: stale .kanban-lock exists (owner=${data.owner}, age=${Math.floor(ageMs / 1000)}s, ttl=${data.ttlSeconds}s)。次回 write 時に強制取得します。`,
        );
      } else {
        warnings.push(
          `L2: active .kanban-lock exists (owner=${data.owner}, uuid=${data.uuid.slice(0, 8)}...). 別プロセスが書き込み中の可能性があります。`,
        );
      }
    } catch {
      warnings.push("L2: .kanban-lock exists but unreadable / unparseable.");
    }
  }

  // --- L3 --- schema audit
  private async checkL3SchemaAudit(warnings: string[], errors: string[]): Promise<void> {
    const audit = new SchemaAudit(this.app, this.opts.tasksDir);
    const result = await audit.run();
    for (const w of result.warnings) {
      warnings.push(`L3 audit: ${w.file}: ${w.message}`);
    }
    for (const e of result.errors) {
      errors.push(`L3 audit: ${e.file}: ${e.message}`);
    }
    console.log("[kanban] schema audit", {
      scanned: result.scannedCount,
      errors: result.errors.length,
      warnings: result.warnings.length,
    });
  }

  // --- L4 --- バックアップ存在チェック
  private async checkL4Backup(warnings: string[]): Promise<void> {
    const backupRel = this.opts.backupDir ?? `${this.opts.tasksDir}/_archive`;
    const maxAgeDays = this.opts.backupMaxAgeDays ?? DEFAULT_BACKUP_MAX_AGE_DAYS;
    const basePath = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
    if (!basePath) {
      warnings.push("L4: cannot resolve vault base path for backup check.");
      return;
    }
    const abs = path.join(basePath, backupRel);
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isDirectory()) {
        warnings.push(`L4: backup path "${backupRel}" exists but is not a directory.`);
        return;
      }
      // review#Minor8 反映：withFileTypes で stat 呼び出し回数を削減
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      if (entries.length === 0) {
        warnings.push(
          `L4: backup directory "${backupRel}" is empty. Phase 4 migration の前に強制バックアップを取ります。`,
        );
        return;
      }
      // 最新エントリの mtime 確認（dir/file 両対応）
      let newest = 0;
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue;
        const s = await fs.promises.stat(path.join(abs, ent.name));
        if (s.mtimeMs > newest) newest = s.mtimeMs;
      }
      const ageDays = (Date.now() - newest) / (1000 * 60 * 60 * 24);
      if (ageDays > maxAgeDays) {
        warnings.push(
          `L4: newest backup is ${ageDays.toFixed(1)} days old (max=${maxAgeDays}). Phase 4 で再バックアップ推奨。`,
        );
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // バックアップ未作成は Phase 4 で対応するので warn のみ
        warnings.push(`L4: backup directory "${backupRel}" not found. Phase 4 で初回作成されます。`);
      } else {
        warnings.push(`L4: backup check failed: ${(e as Error).message}`);
      }
    }
  }
}
