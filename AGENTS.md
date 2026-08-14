# knot

Cosense (Scrapbox) 互換のセルフホスト wiki。
Node.js >= 26 の type stripping で動くのでサーバ側のビルドは無い。
概要と起動手順は `README.md`、運用は `docs/ops.md`。

## 実行環境

- 開発環境は nix flake + direnv。コマンドは `direnv exec . <cmd>` で実行する。
- `node_modules` は dev shell が用意する。手で `npm install` / `npm ci` を実行しない（CI だけが `npm ci` を使う）。
- Playwright のブラウザは Nix が提供する。`npx playwright install` をローカルで実行しない。

## TypeScript

- サーバと CLI は type stripping で直接実行する。`tsc` は `--noEmit` の型検査専用。
- `erasableSyntaxOnly` が有効。enum、namespace、parameter property は使えない。
- 相対 import は拡張子 `.ts` を付ける（`allowImportingTsExtensions`）。
- `noUncheckedIndexedAccess` が有効。`xs[i]` は `T | undefined` として扱う。

## クライアントバンドル

- `public/build/` は gitignore された生成物（エントリに加えて共有チャンクも出る）。
- `knot serve` を手で起動する前に `npm run build:client` が必要。これが無いと編集画面・検索・ページ操作メニューが動かない。
- e2e は Playwright の `webServer` が `build:client` を実行するので、事前ビルドは要らない。

## 品質検査

- 方針は `docs/quality-gates.md`。不具合または不要コードを検出できる検査だけを CI の合否条件にする。
- 複雑度、関数行数、ネスト、引数数、コード重複率のラチェットを追加しない。
- lint の例外は、対象行の直前に `// oxlint-disable-next-line <rule>` と理由コメントを置く。
  ファイル単位の抑制や `.oxlintrc.json` の例外リストには戻さない。
- `reportUnusedDisableDirectives` が `deny`。不要になった抑制コメントは lint エラーになるので消す。

## ストレージ

- スキーマ変更は `src/storage/migrations/NNNN_<name>.sql` を追加する。
- 適用済みかどうかは `PRAGMA user_version` で判定する。既存のマイグレーションファイルを後から書き換えない。

## テスト

- 単体・統合テストは `node --test 'test/**/*.test.ts'`（`npm test`）。
- サーバのテストは `test/helpers/server.ts` の `makeServer()` を使う。
  in-memory SQLite と固定クロック（`clock.t`）で動き、実ポートを開かない。新しくポートを開く形のテストを増やさない。
- `test/acceptance/` は外部の Cosense 互換ツール（`@helpfeel/cosense-cli`、`scrapbox-cosense-mcp`）に対する互換性テスト。

## 作業の進め方

- 作業単位は GitHub issue。issue → ブランチ → PR で進め、PR は 1 つの意図に絞る。
- コミットメッセージは日本語で、Conventional Commits の type を付ける（`fix(sync): ...`）。

## ドキュメント

- 実装計画書やタスクの進捗報告を `docs/` に残さない。
- ただし「実装したから消してよい」ではない。決定の理由、却下した案、未完了の確認事項、環境依存の検証結果はコードから導出できない。
  消す前に ADR か issue へ移す。
- `docs/` に置くのは読者が実在する恒久文書だけ（`ops.md`、`security-requirements.md`、`quality-gates.md`、`adr/`）。
- `docs/` に `SECURITY.md` を置かない（大文字小文字を問わない）。
  GitHub は `.github/`・ルート・`docs/` の同名ファイルを脆弱性報告ポリシーとして公開するため、内部文書が報告者向けページとして表示される。
  報告ポリシーはルートの `SECURITY.md`、実装の安全要件は `docs/security-requirements.md`。
- ブランチ寿命の会話文脈は `.dev/contexts/`（gitignore 済み）に置く。

## 用語と決定の記録

- 用語は `CONTEXT.md` に従う。新しい語を導入する前にそこを見る。
- 定義を追加するのは普通の作業だが、既存の定義を変えるのは合意が要る。黙って書き換えない。
- ADR は `docs/adr/NNNN-<名前>.md`。後戻りが難しく、文脈なしでは意外で、実際に代替案があった決定だけを書く。
- 決定を覆すときは新しい ADR を書き、古い方に `superseded by` を付ける。古い ADR の本文は書き換えない。
