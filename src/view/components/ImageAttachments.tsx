import * as React from "react";
import { Notice, type App, type TFile } from "obsidian";
import { useBoardStore } from "../../store/boardStore";
import { resolveAttachmentDir } from "../../settings/PluginSettings";

/**
 * Phase 9: タスク詳細ペインの添付ファイルセクション（画像 + PDF）。
 *
 * 機能:
 * - クリップボードペースト (Cmd+V): DetailPane 内 focus 時のみ拾う（画像のみ）
 * - ドラッグ&ドロップ: このセクション領域に drop（画像 + PDF）
 * - ファイル選択ボタン（画像 + PDF）
 *
 * 保存先 (v0.5.1):
 * - kanban 専用設定 `attachmentDir` を優先 (デフォルト `<tasksDir>/_attachments`)
 * - boardStore.attachmentDir をミラーとして購読、設定変更時に即時反映
 * - ファイル名: `{taskId}-pasted-{YYYYMMDDHHMMSS}{ext}`
 *
 * 既存添付の検出:
 * - bodyMarkdown 全体から `![[xxx.png|jpg|gif|webp|pdf]]` を grep
 * - 重複は dedup
 *
 * 表示:
 * - 画像: vault.adapter.getResourcePath で file:// URL → <img>
 * - PDF: アイコン + ファイル名 → クリックで Obsidian 内タブで開く
 *
 * 連携:
 * - 新規追加: onInsert(filename) で form 側 (memo 末尾) に挿入
 * - 削除: onRemove(filename) で form の text fields から該当 wikilink を除去 + vault からも削除
 */
const ATTACHMENT_EXT_REGEX = /\.(png|jpe?g|gif|webp|pdf)$/i;
const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp)$/i;
const PDF_EXT_REGEX = /\.pdf$/i;
const WIKILINK_RE = /!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp|pdf))(?:\|[^\]]*)?\]\]/gi;

/**
 * vault 相対パスのフォルダ階層を上から順に作成する。
 * Obsidian の createFolder は親ディレクトリ無しで失敗するため、`a/b/c` を作るときは
 * `a`, `a/b`, `a/b/c` の順で adapter.exists → createFolder を回す。
 */
async function ensureFolderRecursive(app: App, dir: string): Promise<void> {
  if (dir === "") return;
  const segments = dir.split("/").filter((s) => s !== "");
  let cur = "";
  for (const seg of segments) {
    cur = cur === "" ? seg : `${cur}/${seg}`;
    if (!(await app.vault.adapter.exists(cur))) {
      try {
        await app.vault.createFolder(cur);
      } catch (e) {
        // 同時実行で重複作成された場合は無視
        if (!(await app.vault.adapter.exists(cur))) throw e;
      }
    }
  }
}

function nowStamp(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getFullYear()) +
    p2(d.getMonth() + 1) +
    p2(d.getDate()) +
    p2(d.getHours()) +
    p2(d.getMinutes()) +
    p2(d.getSeconds())
  );
}

function sanitizeBasename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function extractImageWikilinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  // exec を回す前に lastIndex を初期化 (state を持つ正規表現の再利用対策)
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

interface Props {
  app: App;
  /** v0.5.1: kanban 専用添付フォルダの解決に使う（既定 `<tasksDir>/_attachments`） */
  tasksDir: string;
  taskId: string;
  bodyMarkdown: string;
  /** 新規画像保存後に呼ばれる。form の memo 末尾に `![[filename]]` を挿入する想定 */
  onInsert: (filename: string) => void;
  /** 削除ボタン押下時。form の各 text field から該当 wikilink を除去する想定 */
  onRemove: (filename: string) => void;
}

export function ImageAttachments({ app, tasksDir, taskId, bodyMarkdown, onInsert, onRemove }: Props) {
  const attachmentDirSetting = useBoardStore((s) => s.attachmentDir);
  const attachmentDir = resolveAttachmentDir(attachmentDirSetting, tasksDir);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLFieldSetElement>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);
  // 多重保存防止 (D&D で同じファイルを連続 drop した場合の保険)
  const savingRef = React.useRef<Set<string>>(new Set());

  const attachments = React.useMemo(() => extractImageWikilinks(bodyMarkdown), [bodyMarkdown]);

  const resolveResourcePath = React.useCallback(
    (filename: string): string | null => {
      const dir = attachmentDir;
      const full = dir === "" ? filename : `${dir}/${filename}`;
      const f = app.vault.getAbstractFileByPath(full);
      if (!f) return null;
      try {
        return app.vault.adapter.getResourcePath(full);
      } catch {
        return null;
      }
    },
    [app, attachmentDir],
  );

  const saveImage = React.useCallback(
    async (file: File): Promise<void> => {
      if (!ATTACHMENT_EXT_REGEX.test(file.name)) {
        new Notice(`対応外のファイル形式です: ${file.name}（画像 / PDF のみ）`);
        return;
      }
      const key = `${file.name}:${file.size}`;
      if (savingRef.current.has(key)) return;
      savingRef.current.add(key);
      try {
        const ext = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ".png";
        const baseName = `${sanitizeBasename(taskId)}-pasted-${nowStamp()}${ext}`;
        const dir = attachmentDir;
        // 親ディレクトリ階層を上から順に作成 (Obsidian の createFolder は親無しで失敗するため)
        await ensureFolderRecursive(app, dir);
        let fullPath = dir === "" ? baseName : `${dir}/${baseName}`;
        // 衝突回避 (同 ms に複数 paste される稀ケース)
        if (await app.vault.adapter.exists(fullPath)) {
          fullPath = fullPath.replace(/(\.[^.]+)$/, `-${Math.random().toString(36).slice(2, 6)}$1`);
        }
        const ab = await file.arrayBuffer();
        await app.vault.createBinary(fullPath, ab);
        onInsert(fullPath.split("/").pop()!);
        new Notice(`画像を保存: ${baseName}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
        new Notice(`画像保存失敗: ${msg}`);
        console.error("[kanban] image save failed:", e);
      } finally {
        savingRef.current.delete(key);
      }
    },
    [app, taskId, onInsert, attachmentDir],
  );

  // Clipboard paste (Cmd+V) — DetailPane 内に focus があるときのみ拾う。
  // PDF はクリップボードから来ることが稀なので画像のみ対応 (PDF は D&D / ファイル選択で投入)。
  React.useEffect(() => {
    const handler = (e: ClipboardEvent): void => {
      if (!e.clipboardData) return;
      const ae = document.activeElement;
      if (!ae || !ae.closest(".kanban-detail-pane")) return;
      const items = Array.from(e.clipboardData.items);
      const imageItem = items.find((it) => it.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void saveImage(file);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [saveImage]);

  const openInObsidian = React.useCallback(
    (filename: string): void => {
      const dir = attachmentDir;
      const fullPath = dir === "" ? filename : `${dir}/${filename}`;
      // openLinkText は Obsidian 標準の link 解決を経由する。tab=true で新規タブ表示。
      try {
        void app.workspace.openLinkText(fullPath, "", true);
      } catch (e) {
        console.error("[kanban] openLinkText failed:", e);
      }
    },
    [app, attachmentDir],
  );

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };
  const onDragLeave = (): void => setIsDragOver(false);
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      await saveImage(f);
    }
  };

  const onFileSelect = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) {
      await saveImage(f);
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const onRemoveClick = async (filename: string): Promise<void> => {
    if (!window.confirm(`「${filename}」を削除しますか？\n（vault からも削除されます）`)) return;
    const dir = attachmentDir;
    const fullPath = dir === "" ? filename : `${dir}/${filename}`;
    try {
      const f = app.vault.getAbstractFileByPath(fullPath);
      if (f) {
        // TFile かどうか問わず vault.delete で削除（adapter 経由でゴミ箱）
        await app.vault.delete(f as TFile);
      }
      onRemove(filename);
      new Notice(`削除しました: ${filename}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 80) : "不明なエラー";
      new Notice(`削除失敗: ${msg}`);
      console.error("[kanban] image delete failed:", e);
    }
  };

  return (
    <fieldset
      ref={containerRef}
      className={`kanban-field kanban-attachments-field ${isDragOver ? "is-drag-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        void onDrop(e);
      }}
    >
      <legend className="kanban-field-label">添付ファイル</legend>
      {attachments.length > 0 && (
        <div className="kanban-attachments-grid">
          {attachments.map((filename) => {
            const isPdf = PDF_EXT_REGEX.test(filename);
            const isImage = IMAGE_EXT_REGEX.test(filename);
            const src = isImage ? resolveResourcePath(filename) : null;
            return (
              <div
                key={filename}
                className={`kanban-attachment-item ${isPdf ? "is-pdf" : ""}`}
              >
                {isImage && src && (
                  <img
                    src={src}
                    alt={filename}
                    loading="lazy"
                    onClick={() => openInObsidian(filename)}
                  />
                )}
                {isImage && !src && (
                  <div className="kanban-attachment-missing" title="ファイルが見つかりません">
                    ?
                  </div>
                )}
                {isPdf && (
                  <button
                    type="button"
                    className="kanban-attachment-pdf-thumb"
                    onClick={() => openInObsidian(filename)}
                    aria-label={`${filename} を開く`}
                    title="クリックで開く"
                  >
                    <span className="kanban-attachment-pdf-icon">PDF</span>
                  </button>
                )}
                <div className="kanban-attachment-name" title={filename}>
                  {filename}
                </div>
                <button
                  type="button"
                  className="kanban-attachment-remove"
                  onClick={() => {
                    void onRemoveClick(filename);
                  }}
                  aria-label={`${filename} を削除`}
                  title="削除"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="kanban-attachments-actions">
        <button
          type="button"
          className="kanban-attachments-add"
          onClick={() => inputRef.current?.click()}
        >
          ファイルを添付
        </button>
        <span className="kanban-attachments-hint">
          画像は Cmd+V / D&D / ボタン。PDF は D&D / ボタン
        </span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            void onFileSelect(e);
          }}
        />
      </div>
    </fieldset>
  );
}
