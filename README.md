# knot

Cosense (Scrapbox) 互換のセルフホスト wiki。
サーバは Node.js >= 24 の type stripping で動き、ビルドは不要。
クライアント（エディタ・検索・ページ操作メニュー）だけを Rolldown で `public/build/` へバンドルする。

## 開発

開発環境は nix flake + direnv（`direnv allow`）。
テストや CLI は dev shell 経由で実行する。

```sh
direnv exec . npm test              # node --test
direnv exec . npx tsc --noEmit      # 型検査
direnv exec . npm run lint          # oxlint (src / public / test / e2e)
direnv exec . npm run build:client  # クライアントバンドル生成
direnv exec . npm run watch:client  # バンドルの watch
```

**`knot serve` の前に `npm run build:client` が必要**。
`/assets/build/*.js`（エディタ・検索・ページメニュー）は gitignore された生成物で、バンドルを作らないと編集画面・検索・操作メニューが動かない。

## E2E テスト（Playwright）

初回のみブラウザバイナリを導入する（flake.nix が `PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"` を設定済み）。

```sh
direnv exec . npx playwright install chromium
direnv exec . npm run test:e2e
```

`test:e2e` は一時 data dir に seed した専用サーバ（`e2e/server.ts`）を自動起動し、`npm run build:client` を前段で実行する。
ホストの libc で chromium が動かない環境（純 NixOS 等）では、nixpkgs の `playwright-driver.browsers` に切り替えて `PLAYWRIGHT_BROWSERS_PATH` をそこへ向ける。

## 既知の先送り最適化

- タイトル一覧（エディタ補完・検索が使う `GET /api/pages/:project/search/titles`）はセッション内 1 回の fetch + メモリキャッシュで運用している。
  ETag による差し替えは将来最適化として先送り。
- 未確認コミットを残したままタブを閉じ、その間に他者がページをリネームした場合、再送は 404 で捨てられる（発生条件が稀なため v1 の既知の制限とする）。
