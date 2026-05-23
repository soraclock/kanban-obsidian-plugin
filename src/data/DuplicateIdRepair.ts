import type { App, TFile } from "obsidian";
import { parseFile, stringifyFile } from "./Frontmatter";
import { sha256 } from "./ContentHash";
import { PathLock } from "./PathLock";
import type { SelfWriteTracker } from "./SelfWriteTracker";
import type { WriteJournal } from "./WriteJournal";
import type { ProcessLock } from "./ProcessLock";

/**
 * 同一 ID 番号を持つファイルが複数存在する状態を表す。
 * 主に他 vault からタスクファイルを移行した直後、_README.md の「次のID」が古い値のまま
 * 残り、v0.6.7 未満の TaskCreator が同番号で新規タスクを作って frontmatter id + ファイル名
 * レベルで重複してしまった vault を修復するために使う。
 */
export interface DuplicateGroup {
  /** 重複している ID 番号（例: 1）。`K-0001-*.md` と `K-0001_*.md` のように形式違いでも同番号扱い */
  idNum: number;
  /** 同番号のファイル名群（tasksDir 相対のファイル名のみ、フルパスではない） */
  filenames: string[];
}

/**
 * 1 件の振り直し計画。oldPath / newPath は tasksDir 相対のファイル名。
 */
export interface RenamePlan {
  /** 振り直し前のファイル名（tasksDir 相対） */
  oldFilename: string;
  /** 振り直し後のファイル名（tasksDir 相対）。常に新形式の `K-NNNN-<slug>.md` に正規化される */
  newFilename: string;
  oldIdNum: number;
  newIdNum: number;
}

/**
 * ファイル名から K-NNNN を抽出。
 * 新形式 `K-NNNN-*.md` / 旧形式 `K-NNNN_*.md` / slug 無し `K-NNNN.md` を全部拾う。
 * v0.6.9: 4 桁固定だと 9999 タスクで破綻するため `\d{4,}` で 4 桁以上を許容。
 */
const TASK_ID_FILE_RE = /^K-(\d{4,})(?:[-_](.+))?\.md$/;

/** v0.6.9: 4 桁を保証しつつ ID 番号が 9999 を超えても安全に文字列化 */
function formatIdNum(n: number): string {
  return "K-" + String(n).padStart(4, "0");
}

/**
 * ディレクトリのファイル名群から重複している ID 番号を検出する。
 * 重複していない単独 ID は結果に含めない。idNum 昇順でソート。
 */
export function detectDuplicates(filenames: string[]): DuplicateGroup[] {
  const groups = new Map<number, string[]>();
  for (const name of filenames) {
    const m = name.match(TASK_ID_FILE_RE);
    if (!m) continue;
    const idNum = parseInt(m[1]!, 10);
    if (!groups.has(idNum)) groups.set(idNum, []);
    groups.get(idNum)!.push(name);
  }
  return Array.from(groups.entries())
    .filter(([, files]) => files.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([idNum, filenames]) => ({
      idNum,
      // 旧形式（アンダースコア）を「元から居た側」とみなして先頭固定、その後はファイル名昇順。
      // 振り直されるのは 2 件目以降なので、新規作成された K-NNNN-*.md が振り直し対象になる。
      filenames: [...filenames].sort((a, b) => {
        const aOld = a.match(/^K-\d{4,}_/) !== null;
        const bOld = b.match(/^K-\d{4,}_/) !== null;
        if (aOld && !bOld) return -1;
        if (!aOld && bOld) return 1;
        return a.localeCompare(b);
      }),
    }));
}

/**
 * 全ファイル名から最大 ID 番号を返す（重複検出と振り直しジャンプ先計算に使う）。
 * ファイルが 1 つもない / `K-` 形式でないファイルしかない場合は 0。
 */
export function calcMaxId(filenames: string[]): number {
  let max = 0;
  for (const name of filenames) {
    const m = name.match(TASK_ID_FILE_RE);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return max;
}

/**
 * 重複グループから振り直し計画を作る。各グループの先頭ファイル（detectDuplicates でソート済み）は
 * 据え置き、2 件目以降を `maxExistingId + 1` から順に新 ID へ振り直す。
 * 新ファイル名は常に新形式 `K-NNNN-<slug>.md`。slug は元のファイル名から抽出、無ければ `renamed`。
 */
export function planRepair(
  groups: DuplicateGroup[],
  maxExistingId: number,
): RenamePlan[] {
  let nextId = maxExistingId + 1;
  const plans: RenamePlan[] = [];
  for (const g of groups) {
    for (let i = 1; i < g.filenames.length; i++) {
      const filename = g.filenames[i]!;
      const m = filename.match(TASK_ID_FILE_RE);
      const slug = m && m[2] ? m[2] : "renamed";
      plans.push({
        oldFilename: filename,
        newFilename: `${formatIdNum(nextId)}-${slug}.md`,
        oldIdNum: g.idNum,
        newIdNum: nextId,
      });
      nextId += 1;
    }
  }
  return plans;
}

/**
 * frontmatter の id フィールドを差し替えた新 markdown 文字列を返す純関数。
 * v0.6.9: 既に新 id と等しい場合は再書き込み不要で同じ文字列を返す（冪等）。
 * id が無いファイルや parse 失敗時は throw する（呼び出し側で個別に catch）。
 */
export function rewriteFrontmatterId(content: string, newId: string): string {
  const parsed = parseFile<{ id?: string }>(content);
  if (typeof parsed.data.id !== "string") {
    throw new Error("frontmatter に id がありません");
  }
  if (parsed.data.id === newId) {
    return content;
  }
  const nextData = { ...parsed.data, id: newId };
  return stringifyFile(parsed.content, nextData);
}

/** _README.md の「次のID」を K-NNNN に書き換えた新文字列を返す。一致するパターンが無ければ throw。 */
export function rewriteReadmeNextId(readmeText: string, nextId: string): string {
  const re = /次のID:\s*\*\*K-\d{4,}\*\*/;
  if (!re.test(readmeText)) {
    throw new Error("_README.md に「次のID」パターンが見つかりません");
  }
  return readmeText.replace(re, `次のID: **${nextId}**`);
}

export interface RepairExecutionResult {
  succeeded: RenamePlan[];
  failed: { plan: RenamePlan; error: string }[];
}

export interface ExecuteRepairOptions {
  app: App;
  tasksDir: string;
  readmePath: string;
  plans: RenamePlan[];
  pathLock: PathLock;
  selfWriteTracker: SelfWriteTracker;
  journal: WriteJournal;
  processLock?: ProcessLock;
}

/**
 * RenamePlan 群を順次実行する。各 plan は独立に try/catch するので途中失敗で全体停止しない。
 *
 * 安全性の設計 (v0.6.9 強化):
 * - ProcessLock で全体を直列化（複数 Obsidian instance / sync の race を防ぐ）
 * - PathLock を old/new 両 path にネスト
 * - 順序: rename → modify。rename 失敗時はファイル状態に変化なし。
 *   rename 成功 / modify 失敗時はベストエフォートで rename を巻き戻す。
 * - rename は app.fileManager.renameFile で行う（vault.rename と違い、他ファイルからの
 *   wiki link `[[K-0001-foo]]` が自動追従する）
 * - 各 plan 完了時に WriteJournal に repairDuplicateId エントリを append（監査トレイル）
 * - 全 plan 終了後、_README.md の「次のID」が最大新 ID + 1 より小さければ更新
 */
export async function executeRepair(
  opts: ExecuteRepairOptions,
): Promise<RepairExecutionResult> {
  const { app, tasksDir, readmePath, plans, pathLock, selfWriteTracker, journal, processLock } = opts;

  // ProcessLock を全体で取得（複数 instance race 対策）。タイムアウトしたら全件失敗扱い。
  if (processLock) {
    const acquired = await processLock.acquire();
    if (!acquired) {
      return {
        succeeded: [],
        failed: plans.map((p) => ({ plan: p, error: "ProcessLock 取得タイムアウト" })),
      };
    }
  }

  try {
    const succeeded: RenamePlan[] = [];
    const failed: { plan: RenamePlan; error: string }[] = [];

    for (const plan of plans) {
      const oldPath = `${tasksDir}/${plan.oldFilename}`;
      const newPath = `${tasksDir}/${plan.newFilename}`;
      try {
        await pathLock.with(oldPath, async () => {
          await pathLock.with(newPath, async () => {
            if (app.vault.getAbstractFileByPath(newPath)) {
              throw new Error(`振り直し先が既に存在します: ${newPath}`);
            }
            const file = app.vault.getAbstractFileByPath(oldPath);
            if (!file || !("stat" in file)) {
              throw new Error(`ファイルが見つかりません: ${oldPath}`);
            }
            const tfile = file as TFile;

            const beforeContent = await app.vault.read(tfile);
            const beforeHash = sha256(beforeContent);
            const newId = formatIdNum(plan.newIdNum);
            const updatedContent = rewriteFrontmatterId(beforeContent, newId);
            const afterHash = sha256(updatedContent);

            // rename 先行: 失敗してもファイル内容に変化なし。
            // 成功した場合に備えて newPath 側に self-write を予約。
            selfWriteTracker.markSelf(newPath, beforeHash);
            selfWriteTracker.markSelf(newPath, afterHash);
            await app.fileManager.renameFile(tfile, newPath);

            // modify で frontmatter id を更新。失敗したら rename を巻き戻し（ベストエフォート）。
            try {
              await app.vault.modify(tfile, updatedContent);
            } catch (modifyErr) {
              try {
                selfWriteTracker.markSelf(oldPath, beforeHash);
                await app.fileManager.renameFile(tfile, oldPath);
              } catch (rollbackErr) {
                console.error(
                  "[kanban] repair rollback (rename back) failed:",
                  oldPath,
                  rollbackErr,
                );
              }
              throw modifyErr;
            }

            await journal.append({
              ts: new Date().toISOString(),
              op: "repairDuplicateId",
              path: newPath,
              beforeHash,
              afterHash,
              actor: "migration",
              approved: true,
              beforeData: {
                oldFilename: plan.oldFilename,
                oldId: formatIdNum(plan.oldIdNum),
              },
              afterData: {
                newFilename: plan.newFilename,
                newId,
              },
            });
          });
        });
        succeeded.push(plan);
      } catch (e) {
        failed.push({
          plan,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // _README.md の「次のID」を最大新 ID + 1 より小さければ更新する
    if (succeeded.length > 0) {
      try {
        await pathLock.with(readmePath, async () => {
          const readmeFile = app.vault.getAbstractFileByPath(readmePath);
          if (!readmeFile || !("stat" in readmeFile)) return;
          const tfile = readmeFile as TFile;
          const readmeText = await app.vault.read(tfile);
          const maxNewId = Math.max(...succeeded.map((p) => p.newIdNum));
          const currentMatch = readmeText.match(/次のID:\s*\*\*K-(\d{4,})\*\*/);
          if (!currentMatch) return;
          const currentNext = parseInt(currentMatch[1]!, 10);
          if (currentNext > maxNewId) return; // 既に十分大きければ更新不要
          const nextId = formatIdNum(maxNewId + 1);
          const updated = rewriteReadmeNextId(readmeText, nextId);
          const newHash = sha256(updated);
          selfWriteTracker.markSelf(readmePath, newHash);
          await app.vault.modify(tfile, updated);
        });
      } catch (e) {
        console.warn("[kanban] _README.md の「次のID」更新に失敗:", e);
      }
    }

    return { succeeded, failed };
  } finally {
    if (processLock) {
      try {
        await processLock.release();
      } catch (e) {
        console.warn("[kanban] ProcessLock release error:", e);
      }
    }
  }
}
