# 0003: links・pages_fts・pages.image は lines から再構築できる導出データにする

- 状態: 承認済み
- 決定日: 2026-07-10（記録日: 2026-08-02）

リンクグラフ（`links`）、全文検索索引（`pages_fts`）、代表画像（`pages.image`）は、コミット適用時に AST から導出して保存する二次データとして扱い、これらに対する一次データは `lines` とする。
`projects`、`users`、`attachments`、`sessions`、`title_history`、`page_visits`、`pages.pinned` は本文から導出できない独立した一次データであり、ここでの対象ではない。
どれも `lines` から作り直せる状態を保ち、`knot reindex` で全導出データを再構築できるようにする。

索引の破損対策であると同時に、リンク抽出やレンダリングのロジックを変更したときの再適用手段を兼ねる。
`reindex` コマンドが存在する理由はこれである。

## 帰結

- リンク抽出やメディア分類の実装を変えたら、既存プロジェクトには `knot reindex` が要る。
  マイグレーションでは追随しない。
- `pages_fts` は trigram トークナイザを使う。
  3 文字未満のクエリでは索引を引けずエラーではなく 0 件を返すため、短いクエリは `lines.text` への LIKE 走査にフォールバックする。
  この分岐は storage の検索メソッドの内側に閉じる。
- マイグレーションは連番 SQL を起動時に適用し、適用位置は `PRAGMA user_version` で管理する。
  導出データの作り直しはマイグレーションの役目ではない。

## 参照

蒸留元は knot 設計書（2026-07-10）の「スキーマ」。
同書は superpowers 方式の文書整理で削除した。
原文は `git show 3412fc9:docs/superpowers/specs/2026-07-10-knot-design.md` で読める。
