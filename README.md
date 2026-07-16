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

## 起動（クイックスタート）

CLI は `node src/cli/main.ts` で呼ぶ（`knot <command>` と読み替える）。
初回はデータディレクトリの初期化とユーザー作成が必要。

```sh
direnv exec . npm run build:client

# 1. データディレクトリを初期化（./data は gitignore 済み）
direnv exec . node src/cli/main.ts init --data ./data

# 2. ユーザーを作成（パスワードは標準入力から読む）
echo -n 'パスワード' | direnv exec . node src/cli/main.ts user add --data ./data --name ril

# 3. サーバ起動（既定 http://127.0.0.1:3000）
direnv exec . node src/cli/main.ts serve --data ./data
```

ブラウザで http://127.0.0.1:3000/login からログインする。

プロジェクト作成の UI はまだ無いので、初回は API で作るか import で取り込む。

```sh
# ログインしてセッション cookie を保存
curl -c /tmp/knot-cookies -H 'Content-Type: application/json' -H 'X-Knot-Client: cli' \
  -d '{"name":"ril","password":"パスワード"}' http://127.0.0.1:3000/api/knot/session

# プロジェクト "notes" を作成
curl -b /tmp/knot-cookies -X POST -H 'X-Knot-Client: cli' \
  http://127.0.0.1:3000/api/knot/projects/notes
```

Cosense のエクスポート JSON がある場合は、curl の代わりに `knot import --data ./data --project notes <file.json>` でプロジェクトごと作成できる。

あとは http://127.0.0.1:3000/notes を開くと、一覧の「新規作成」ボタンや `/notes/<タイトル>/edit` への直接アクセスでページを書ける。

## 外部画像の許可ホスト

外部ホストの画像はセキュリティ上 allowlist を通ったものだけ `<img>` 表示する（それ以外はリンクのまま）。
既定は `i.gyazo.com` / `gyazo.com` / `scrapbox.io`（Cosense の添付ファイル）。
追加するにはデータディレクトリの `config.json` に書く（ワイルドカードはサブドメインにだけ一致）。

```json
{ "allowedImageHosts": ["i.gyazo.com", "gyazo.com", "scrapbox.io", "lh3.googleusercontent.com"] }
```

サイト内にアップロードした添付（`/files/…`）は allowlist に関係なく表示される。

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
