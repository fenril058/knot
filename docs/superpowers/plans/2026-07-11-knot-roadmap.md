# knot v1 実装ロードマップ

スペック: `docs/superpowers/specs/2026-07-10-knot-design.md`

v1 を、それぞれ単体で動作確認できるソフトウェアを納品する 6 つの計画に分割する。
番号順に依存する（02 は 01 の成果物を使う、以下同様）。

## 計画一覧

1. **01 core**（`2026-07-11-knot-01-core.md`）
   純粋ドメインモジュール群。ULID、タイトル正規化、行操作の検証と適用、行差分、リベース、リンク抽出、メディア分類、Cosense JSON の型と正規化。
   納品物: I/O を持たないテスト済みライブラリ。決定性、収束などスペックの受け入れ条件のテストを含む。

2. **02 storage-cli**
   SQLite ストレージ実装（マイグレーション、コミットのトランザクション、409/400/冪等性、導出データ更新、検索、reindex）とインポート/エクスポート、CLI（init / import / export / reindex）。
   納品物: 実際の Cosense エクスポート JSON の round-trip が通る CLI。

3. **03 api-server**
   Hono サーバ。認証（scrypt、セッション、connect.sid、CSRF ヘッダ、レートリミット）、Cosense 互換読み取り API、コミット API、添付アップロード、セキュリティヘッダ。
   納品物: curl で登録から編集まで操作できる wiki API。

4. **04 web-read**
   SSR の閲覧系 UI。ページ一覧（カード、ピン留め）、ページ閲覧（レンダラ、関連ページ、赤リンク）、テロメア表示、検索 UI、行 permalink。レンダラの XSS 安全化はここ。
   納品物: ブラウザで読める wiki。

5. **05 editor**
   CodeMirror 6 エディタ。記法ハイライト、補完、自動保存の 3 状態管理、リベース接続、スマートペースト、ショートカット、画像ペースト、複製・リネーム・削除の UI。esbuild バンドル。
   納品物: ブラウザで書ける wiki（v1 機能完成）。

6. **06 ops-compat**
   バックアップ/復元とその自動テスト、Docker イメージ、周辺ツールの受け入れテスト、定期エクスポート、運用ドキュメント（プロキシ設定例を含む）。
   納品物: 配布可能な knot v1。

## 分割の理由

- スペックの層（core → storage → server → client）がそのまま依存方向であり、各計画の成果物が次の計画の土台になる。
- 各計画が「動く・テストできる」状態で終わるため、途中で止めても資産が残る。
- 1 計画あたりのタスク数を、実装者（サブエージェント）が文脈を保てる規模に抑える。

## 全計画共通の制約

- Node.js >= 24。TypeScript は type stripping で直接実行し、ビルドは行わない（クライアントバンドルのみ esbuild）。
- テストは node:test + node:assert/strict。`npm test` で全テストが走る。
- 実行時依存は hono、@progfay/scrapbox-parser、CodeMirror 6 系のみ。DB は node:sqlite、ハッシュは node:crypto。
- タイムスタンプは Unix 秒。ID は ULID（インポート時は Cosense の ID を保持）。
- 隔離環境で実行する場合、worktree は必ず `wt switch --create <branch>` で作る。
