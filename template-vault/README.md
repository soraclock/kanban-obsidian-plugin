# 開始用テンプレート vault

このフォルダは Kanban Obsidian Plugin のセットアップ用テンプレートです。中身を自分の Obsidian vault にコピーして使ってください。

## 使い方

1. このフォルダの `tasks/` を、あなたの Obsidian vault 直下にコピー
2. Obsidian でプラグインを有効化（初回は `Settings → Community plugins → Browse` で本プラグインを ON にする）
3. リボンの Kanban アイコン or コマンドパレットの `Kanban: Open Kanban` で起動
4. サンプルタスク（K-0001 〜 K-0003）が 3 列に並んでいれば成功

## 既定のフォルダパスを変えたい場合

`Settings → Community plugins → Kanban` の **タスクフォルダ** 欄を編集してください。  
変更後は **Obsidian を再起動** すると新しいフォルダを読みに行きます。

## 含まれるもの

- `tasks/_README.md` — タスクファイル（K-NNNN-*.md）のスキーマ説明
- `tasks/_テンプレート.md` — 新規タスクの frontmatter テンプレ
- `tasks/K-0001-sample-未着手.md`
- `tasks/K-0002-sample-進行中.md`
- `tasks/K-0003-sample-確認待ち.md`

サンプルタスクは試したあと削除しても構いません。
