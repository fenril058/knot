# 0001: TypeScript + Hono + SQLite の単一プロセスで作る

- 状態: 承認済み
- 決定日: 2026-07-10（記録日: 2026-08-02）

閲覧は SSR、編集画面だけ CodeMirror 6 を載せる構成とし、サーバは Hono、ストレージは `node:sqlite` にした。
Cosense 記法のパーサ資産（`@progfay/scrapbox-parser`）を直接使える言語が TypeScript しかなく、サーバとエディタを単一言語で書けることが決め手である。
将来 Cloudflare Workers + D1 でも動かせるよう、ストレージ層は差し替え可能な境界として保つ。

## 却下した案

**Go 単一バイナリ**。
配布は最も単純だが、Scrapbox 記法パーサを自作することになり、互換性の最難関を自前で背負う。
加えて Workers への移行路が事実上閉じるため、要件と矛盾する。

CRDT ファーストを採らなかった理由は書き込みモデルの決定なので [0002](0002-line-ops-as-canonical-write-form.md) に記す。

## 明文化されていない制約

- 想定利用者は 2〜5 人。
- 運用費は月 1000 円以内（自宅 PC + Cloudflare Tunnel、または格安 VPS）。
- ネイティブ依存のビルド問題と依存パッケージの寿命リスクを避けるため、SQLite とパスワードハッシュ（scrypt）はランタイム内蔵機能を使う。
  `node:sqlite` の API が安定途上である点は残るリスクとして受け入れ、問題が出た場合は better-sqlite3 へ差し替える。
  この差し替えが `src/storage/` の内側で完結することが、ここでの設計上の条件である。

## 参照

蒸留元は `docs/superpowers/specs/2026-07-10-knot-design.md`（最終コミット `3412fc9`）の「採用アプローチと代替案」「技術選定の根拠」。
同文書はバンドラを esbuild としているが、現在は Rolldown を使う。
