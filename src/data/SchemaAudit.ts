import type { App, TFile } from "obsidian";
import { parseFile, type FrontmatterFile } from "./Frontmatter";
import { TaskFrontmatterSchema, STATUS_VALUES, type TaskFrontmatter } from "./TaskSchema";
import { statusHasVariance } from "../util/normalize";
import { DANGEROUS_FRONTMATTER_KEYS, MAX_FILE_SIZE_BYTES } from "./Constants";

export interface AuditFinding {
  level: "error" | "warning";
  file: string;
  message: string;
}

export interface AuditResult {
  errors: AuditFinding[];
  warnings: AuditFinding[];
  scannedCount: number;
  generatedAt: string;
}

const KNOWN_KEYS = new Set([
  "id",
  "title",
  "status",
  "assignee",
  "priority",
  "due",
  "model",
  "created",
  "updated",
  "tags",
  "related",
  "order",
  // Phase 4 以降で導入予定（audit では未知キー警告から除外）
  "parent",
  "dependsOn",
  "estimateHours",
  "actualHours",
  "boardId",
  "completedAt",
  "recurrence",
  "recurringHistoryOf",
]);

// 防御パラメータは Constants に集約（TaskRepository でも再利用）

export class SchemaAudit {
  constructor(
    private readonly app: App,
    private readonly tasksDir: string,
  ) {}

  async run(): Promise<AuditResult> {
    const errors: AuditFinding[] = [];
    const warnings: AuditFinding[] = [];

    const files = this.collectTaskFiles();
    const idToPaths = new Map<string, string[]>();
    // status -> order -> [paths]
    const ordersByStatus = new Map<string, Map<number, string[]>>();
    // dependsOn / parent の参照整合用に id 集合
    const knownIds = new Set<string>();
    const allReferences: Array<{ file: string; key: "parent" | "dependsOn"; refId: string }> = [];

    for (const file of files) {
      // ファイルサイズ上限チェック（OOM 対策、巨大ファイル DoS 防御）
      const size = (file as unknown as { stat?: { size?: number } }).stat?.size;
      if (typeof size === "number" && size > MAX_FILE_SIZE_BYTES) {
        errors.push({
          level: "error",
          file: file.path,
          message: `file size ${size} exceeds limit ${MAX_FILE_SIZE_BYTES} (skipped to avoid OOM)`,
        });
        continue;
      }

      const content = await this.app.vault.read(file);
      let parsed: FrontmatterFile;
      try {
        parsed = parseFile(content);
      } catch (e) {
        errors.push({ level: "error", file: file.path, message: `frontmatter parse failed: ${(e as Error).message}` });
        continue;
      }

      // prototype pollution 系の危険キー（KNOWN_KEYS チェックより先に弾く）
      for (const key of Object.keys(parsed.data)) {
        if (DANGEROUS_FRONTMATTER_KEYS.has(key)) {
          errors.push({
            level: "error",
            file: file.path,
            message: `dangerous frontmatter key "${key}" detected`,
          });
        }
      }

      // schema 検証
      const result = TaskFrontmatterSchema.safeParse(parsed.data);
      if (!result.success) {
        errors.push({
          level: "error",
          file: file.path,
          message: `schema invalid: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        });
        continue;
      }
      const fm: TaskFrontmatter = result.data;
      knownIds.add(fm.id);

      // filename-id 一致
      if (!file.name.startsWith(fm.id + "-")) {
        errors.push({
          level: "error",
          file: file.path,
          message: `filename does not start with id "${fm.id}-"`,
        });
      }

      // duplicate id 集計
      const paths = idToPaths.get(fm.id) ?? [];
      paths.push(file.path);
      idToPaths.set(fm.id, paths);

      // status 表記揺れ
      const rawStatus = (parsed.data as { status?: unknown }).status;
      if (typeof rawStatus === "string") {
        const variance = statusHasVariance(rawStatus);
        if (variance.variant) {
          errors.push({
            level: "error",
            file: file.path,
            message: `status has variance: raw="${rawStatus}", canonical="${variance.canonical ?? "<unknown>"}"`,
          });
        }
      }

      // order
      if (fm.order === undefined) {
        warnings.push({
          level: "warning",
          file: file.path,
          message: "order missing (Phase 4 migration candidate)",
        });
      } else {
        const m = ordersByStatus.get(fm.status) ?? new Map<number, string[]>();
        const ps = m.get(fm.order) ?? [];
        ps.push(file.path);
        m.set(fm.order, ps);
        ordersByStatus.set(fm.status, m);
      }

      // body checkbox section
      if (!parsed.content.includes("## 次のアクション")) {
        warnings.push({
          level: "warning",
          file: file.path,
          message: "'## 次のアクション' section missing in body",
        });
      }

      // 未知キー検出（Phase 4 以降の予約キーは除外）
      for (const key of Object.keys(parsed.data)) {
        if (!KNOWN_KEYS.has(key)) {
          warnings.push({
            level: "warning",
            file: file.path,
            message: `unknown frontmatter key "${key}"`,
          });
        }
      }

      // 参照整合（parent / dependsOn）
      const rawData = parsed.data as Record<string, unknown>;
      if (typeof rawData.parent === "string") {
        allReferences.push({ file: file.path, key: "parent", refId: rawData.parent });
      }
      if (Array.isArray(rawData.dependsOn)) {
        for (const dep of rawData.dependsOn) {
          if (typeof dep === "string") {
            allReferences.push({ file: file.path, key: "dependsOn", refId: dep });
          }
        }
      }
    }

    // duplicate id
    for (const [id, paths] of idToPaths.entries()) {
      if (paths.length > 1) {
        errors.push({
          level: "error",
          file: paths[0]!,
          message: `duplicate id "${id}" across files: ${paths.join(", ")}`,
        });
      }
    }

    // order duplicate
    for (const [status, m] of ordersByStatus.entries()) {
      for (const [order, paths] of m.entries()) {
        if (paths.length > 1) {
          warnings.push({
            level: "warning",
            file: paths[0]!,
            message: `duplicate order ${order} in status "${status}": ${paths.join(", ")}`,
          });
        }
      }
    }

    // 参照整合（後パス）
    for (const ref of allReferences) {
      if (!knownIds.has(ref.refId)) {
        errors.push({
          level: "error",
          file: ref.file,
          message: `${ref.key} reference "${ref.refId}" not found in task set`,
        });
      }
    }

    return {
      errors,
      warnings,
      scannedCount: files.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private collectTaskFiles(): TFile[] {
    const all = this.app.vault.getMarkdownFiles();
    return all.filter(
      (f) =>
        f.path.startsWith(this.tasksDir + "/") &&
        !f.path.startsWith(this.tasksDir + "/_archive/") &&
        f.name.startsWith("K-") &&
        f.name.endsWith(".md"),
    );
  }
}
