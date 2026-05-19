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

`.obsidian/plugins/kanban-obsidian/` を vault 内に作り、リリースの `main.js` / `manifest.json` / `styles.css` を配置します。

```bash
mkdir -p your-vault/.obsidian/plugins/kanban-obsidian
# GitHub Release から main.js / manifest.json / styles.css を DL してここに置く
```

[BRAT](https://github.com/TfTHacker/obsidian42-brat) を使えば自動配置 + 自動更新できます（推奨）。

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
