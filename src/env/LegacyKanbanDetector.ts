/**
 * 旧 Hono kanban (port 3001) の起動検知 + admin/lock POST。
 * Phase 0 ゲートで使用。
 */

export interface DetectResult {
  running: boolean;
  reason?: string;
}

export interface LockResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export class LegacyKanbanDetector {
  constructor(
    private readonly port: number,
    private readonly timeoutMs: number = 2000,
  ) {}

  async detect(): Promise<DetectResult> {
    const url = `http://127.0.0.1:${this.port}/api/health`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) {
        return { running: true, reason: `health 200` };
      }
      return { running: false, reason: `health ${res.status}` };
    } catch (e) {
      const msg = (e as Error).message;
      return { running: false, reason: `fetch failed: ${msg}` };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * 旧 Hono に /lock を POST、token を取得して保持する。
   * 同じインスタンスから requestUnlock(token) で解除可能。
   * review#Major1 反映：unlock には token 必須。
   */
  async requestLock(): Promise<LockResult & { token?: string }> {
    const url = `http://127.0.0.1:${this.port}/api/admin/lock`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "kanban-obsidian-plugin" }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        return { ok: false, status: res.status };
      }
      const data = (await res.json().catch(() => ({}))) as { token?: string };
      return { ok: true, status: res.status, token: data.token };
    } catch (e) {
      return { ok: false, reason: `fetch failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Plugin が onunload 時に呼ぶ。lock 時に発行された token を Bearer 送信。
   */
  async requestUnlock(token: string): Promise<LockResult> {
    const url = `http://127.0.0.1:${this.port}/api/admin/unlock`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, reason: `fetch failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(t);
    }
  }

  async checkStatus(): Promise<{ locked: boolean | null; reason?: string }> {
    const url = `http://127.0.0.1:${this.port}/api/admin/status`;
    try {
      const res = await fetch(url);
      if (!res.ok) return { locked: null, reason: `status ${res.status}` };
      const data = (await res.json()) as { locked?: boolean };
      return { locked: data.locked ?? null };
    } catch (e) {
      return { locked: null, reason: `fetch failed: ${(e as Error).message}` };
    }
  }
}
