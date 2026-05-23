import type { App, TFile } from "obsidian";
import { parseFile, stringifyFile } from "./Frontmatter";
import { sha256 } from "./ContentHash";
import { PathLock } from "./PathLock";
import type { SelfWriteTracker } from "./SelfWriteTracker";

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

/** ファイル名から K-NNNN を抽出。新形式 `K-NNNN-*.md` と旧形式 `K-NNNN_*.md`、slug 無し `K-NNNN.md` を全部拾う。 */
const TASK_ID_FILE_RE = /^K-(\d{4})(?:[-_](.+))?\.md$/;

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
        const aOld = a.match(/^K-\d{4}_/) !== null;
        const bOld = b.match(/^K-\d{4}_/) !== null;
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
      const newId = "K-" + String(nextId).padStart(4, "0");
      plans.push({
        oldFilename: filename,
        newFilename: `${newId}-${slug}.md`,
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
 * id が無いファイルや parse 失敗時は throw する（呼び出し側で個別に catch）。
 */
export function rewriteFrontmatterId(content: string, newId: string): string {
  const parsed = parseFile<{ id?: string }>(content);
  if (typeof parsed.data.id !== "string") {
    throw new Error("frontmatter に id がありません");
  }
  const nextData = { ...parsed.data, id: newId };
  return stringifyFile(parsed.content, nextData);
}

export interface RepairExecutionResult {
  succeeded: RenamePlan[];
  failed: { plan: RenamePlan; error: string }[];
}

/**
 * RenamePlan 群を順次実行する。各 plan は独立に try/catch するので途中失敗で全体停止しない。
 * 中断後に再実行しても、成功した plan は既に新 ID に置き換わっているため次回は重複検出から外れる。
 *
 * 順序: frontmatter id 更新 (modify) → ファイル rename。modify 結果の hash を SelfWriteTracker
 * に記録して VaultWatcher の echo を抑止。PathLock は old/new 両 path を取って rename race を防ぐ。
 */
export async function executeRepair(
  app: App,
  tasksDir: string,
  plans: RenamePlan[],
  selfWriteTracker: SelfWriteTracker,
  pathLock: PathLock,
): Promise<RepairExecutionResult> {
  const succeeded: RenamePlan[] = [];
  const failed: { plan: RenamePlan; error: string }[] = [];

  for (const plan of plans) {
    const oldPath = `${tasksDir}/${plan.oldFilename}`;
    const newPath = `${tasksDir}/${plan.newFilename}`;
    try {
      // rename 後の path にも race で同名ファイルが作られないよう、old/new 両方をロック。
      // 順序固定 (oldPath → newPath) でデッドロック回避。
      await pathLock.with(oldPath, async () => {
        await pathLock.with(newPath, async () => {
          // newPath に同名ファイルが既にある場合は中断（rename で上書きが起きないようガード）
          if (app.vault.getAbstractFileByPath(newPath)) {
            throw new Error(`振り直し先が既に存在します: ${newPath}`);
          }
          const file = app.vault.getAbstractFileByPath(oldPath);
          if (!file || !("stat" in file)) {
            throw new Error(`ファイルが見つかりません: ${oldPath}`);
          }
          const tfile = file as TFile;
          const content = await app.vault.read(tfile);
          const newId = "K-" + String(plan.newIdNum).padStart(4, "0");
          const updated = rewriteFrontmatterId(content, newId);
          const newHash = sha256(updated);
          selfWriteTracker.markSelf(oldPath, newHash);
          await app.vault.modify(tfile, updated);
          // rename は path 変更のみ。新 path に対しても直後の echo を抑止するため記録する
          selfWriteTracker.markSelf(newPath, newHash);
          await app.vault.rename(tfile, newPath);
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

  return { succeeded, failed };
}
