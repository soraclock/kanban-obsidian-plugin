# Kanban Obsidian Plugin

Obsidian の vault 内 Markdown ファイルをそのままタスク管理用カンバンとして扱うプラグイン。1 タスク = 1 ファイル（frontmatter にステータス・優先度・期限などを保存）。Vault と一体なので、Obsidian Sync / iCloud / Git で同期すれば iPhone でも見られる。

## 特徴

- **データは Markdown ファイル**: ロックインなし。プラグインを抜いてもファイルは vault に残る
- **5 つの状態 + 4 つのビュー**: ボード / リスト / フォーカス / カレンダー / 統計
- **DnD によるドラッグ並べ替え**: 列間移動 + 同列内 reorder（dnd-kit）
- **詳細ペイン**: 期限 / 優先度 / 担当 / タグ / サブタスク / 繰り返し / 画像 PDF 添付
- **コマンドパレット + ホットキー対応**: ビュー切替 / レイアウト切替 / 新規タスク / フィルタクリア など 11 個
- **起動時の期限通知**: 超過 / 当日期限の件数を Notice で表示（1 日 1 回）
- **フィルタプリセット**: ステータス絞り込み + 担当 + タグ をローカルに保存
- **モバイル対応**: iPhone / iPad 版 Obsidian でも動く
- **楽観的並行制御**: contentHash + 3-way merge で「他で編集された」を検知
- **監査ジャーナル**: `.kanban-journal.jsonl` に before/after hash を append-only 記録

## セットアップ（3 ステップ）

### 1. テンプレ vault をコピー

リポジトリ内の `template-vault/tasks/` を、お使いの Obsidian vault の **直下** にコピーしてください。

```
your-vault/
├── tasks/
│   ├── _README.md
│   ├── _テンプレート.md
│   ├── K-0001-sample-未着手.md
│   ├── K-0002-sample-進行中.md
│   └── K-0003-sample-確認待ち.md
└── （その他のファイル）
```

サンプルタスクは試したあと削除して構いません。タスクフォルダ名を別にしたい場合は、後述の「設定」を参照。

### 2. プラグインをインストール

#### 方法 A: BRAT で自動化（推奨）

[BRAT](https://github.com/TfTHacker/obsidian42-brat) は Obsidian の β プラグインを GitHub repo から直接インストール / 自動更新するためのプラグインです。

1. Obsidian の `Settings → Community plugins → Browse` で **Obsidian42 - BRAT** を検索してインストール、有効化
2. コマンドパレットで `BRAT: Plugins: Add a beta plugin for testing` を実行
3. 表示されたダイアログに以下を貼り付け、`Add Plugin`:
   ```
   soraclock/kanban-obsidian-plugin
   ```
4. インストールが終わったら `Settings → Community plugins → Installed plugins` で **Kanban Task Board** を ON

以降、BRAT が自動で更新をチェックします。

#### 方法 B: 手動配置

GitHub Release ページから `main.js` / `manifest.json` / `styles.css` を DL し、vault 内の `.obsidian/plugins/kanban-obsidian/` に置きます。

```bash
mkdir -p your-vault/.obsidian/plugins/kanban-obsidian
# Release から 3 ファイルを DL して上のディレクトリに置く
```

### 3. 有効化

Obsidian を起動し、`Settings → Community plugins → Installed plugins` で **Kanban** を ON にします。リボンの Kanban アイコン or コマンドパレット `Kanban: Open Kanban` で起動。

サンプルタスク 3 件が 3 列に並んでいれば成功です。

## 設定

`Settings → Community plugins → Kanban` で以下を変更できます。

- **タスクフォルダ**: タスクファイルを置く vault 内パス（既定 `tasks`）。`projects/kanban` のようなサブフォルダも可。変更後は **Obsidian を再起動** してください。

## frontmatter スキーマ

```yaml
---
id: K-0001                       # K-NNNN 形式
title: タスクのタイトル
status: 未着手                   # 未着手 | 進行中 | 確認待ち | 完了 | 凍結
assignee: 自分                   # 自由記入
priority: P1                     # P0 | P1 | P2 | P3
due: 2026-05-31                  # YYYY-MM-DD。期限なしは省略
created: 2026-05-19
updated: 2026-05-19
tags: [reading, sample]          # 配列
related: []                      # Obsidian リンクの配列
completedAt: null
estimateHours: null
actualHours: null
recurrence: null                 # null | daily | weekly:mon | monthly:15 | monthly:lastday | every:7d
---

## 背景
（なぜこのタスクが必要か）

## 次のアクション
- [ ] チェックボックスで列挙

## メモ
```

詳細は `template-vault/tasks/_README.md` を参照。

## 定期タスク（recurrence）

frontmatter の `recurrence` に書式を書くと、完了時に **次回分のタスクが自動生成** されます。

### 書式

| 書式 | 意味 |
|---|---|
| `daily` | 毎日 |
| `weekly:mon` | 毎週 月曜（`sun` / `mon` / `tue` / `wed` / `thu` / `fri` / `sat`） |
| `monthly:15` | 毎月 15 日（1〜31。月末を超える日付は当月末に丸め） |
| `monthly:lastday` | 毎月末日 |
| `every:7d` | N 日ごと（`every:3d` = 3 日ごと、など） |

### 完了したときに起きること

1. **元のタスクはそのまま残る**（`status=完了` / `completedAt=完了した日`）→ 完了タブに履歴として並ぶ
2. **新しい `K-NNNN` ファイルが自動生成される**
   - `status=未着手` / `due=次回の期限` / `completedAt=null`
   - サブタスク（`- [x]` / `- [ ]`）は全て unchecked にリセット
   - `recurrence` 書式は引き継ぎ
   - 本文・タイトル・タグ・優先度・担当・見積もり時間は引き継ぎ
   - 実績時間（`actualHours`）は引き継がない（毎回ゼロから）

### 次回 due の計算基準

次回の期限は **「元タスクの `due` がある場合は `due` を基準、なければ完了日を基準」** で計算します。

| 元 `due` | `recurrence` | 完了日 | 次回 `due` |
|---|---|---|---|
| 2026-05-25(月) | `weekly:mon` | 2026-05-25 | 2026-06-01(月) |
| 2026-05-25 | `daily` | 2026-05-27（遅れて完了） | 2026-05-26 |
| 未設定 | `daily` | 2026-05-20 | 2026-05-21 |

→ **`due` を入れた方が「いつから次の周期を数えるか」が安定** します。`due` 未設定だと「実際に完了した日」が基準になるので、遅れて完了すると次回もズレていきます。

### 運用の推奨

- 定期タスクは **`recurrence` と `due` の両方を入れる**（次回基準を `due` に固定）
- 「毎週水曜の会議準備」のように曜日固定なら `weekly:wed` + 直近の水曜を `due` に
- `completedAt` は手で触らない（完了ボタン押下時に自動セットされ、繰り返しの基準には基本使われない）
- 元タスクは履歴として残るのが設計意図。月単位でセクション分けされるので運用上は問題なし

### よくある誤解

- ❌「`due` を入れたら一度きりのタスクになる」→ なりません。`recurrence` と `due` は独立して動きます
- ❌「`completedAt` を入れたら繰り返しが壊れる」→ 壊れません。`completedAt` は完了時に自動でセットされるだけで、次回 due の計算には基本使われません（`due` 未設定時のフォールバックでのみ使用）
- ❌「完了ボタンを押すと元タスクが消える」→ 消えません。完了タブに移動して履歴として残ります

## 既知の制限

- タスクフォルダの変更は Obsidian 再起動が必要（hot-reload しない）
- ステータス値（未着手 / 進行中 / 確認待ち / 完了 / 凍結）は現状固定。設定での変更は未対応
- frontmatter キー名（status / priority / due 等）も現状固定
- カレンダービューは月単位、週ビューはなし
- 履歴ジャーナル `.kanban-journal.jsonl` は append-only。ローテーションは手動
- 1 ファイル 1 MB 超は読み込まれません（OOM 対策）

## 開発

```bash
git clone https://github.com/<your-username>/kanban-obsidian-plugin
cd kanban-obsidian-plugin
npm install
npm test                # vitest（218 tests）
npm run build           # esbuild production build
```

開発中の vault に配置:

```bash
cp main.js styles.css manifest.json /path/to/vault/.obsidian/plugins/kanban-obsidian/
```

## アーキテクチャ要点

- **`processFrontMatter`** で frontmatter のみ更新（本文を巻き戻さない）
- **PathLock + `.kanban-lock`** でプロセス内 + プロセス間の write 排他
- **ContentHash** で楽観的並行制御（衝突時は 3-way merge UI）
- **WriteJournal** に append-only で操作履歴を記録
- **VaultWatcher** で外部編集 / Obsidian Sync を検知して store 部分更新
- **SelfWriteTracker** で自分の write イベントをエコーで二重反映しない

## ライセンス

MIT License。`LICENSE` ファイルを参照。
