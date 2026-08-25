# knot

Cosense (Scrapbox) 互換のセルフホスト wiki。
サーバは Node.js >= 26 の type stripping で動き、ビルドは不要。
クライアント（エディタ・検索・ページ操作メニュー）だけを Rolldown で `public/build/` へバンドルする。

## 開発

開発環境は nix flake + direnv（`direnv allow`）。
テストや CLI は dev shell 経由で実行する。

```sh
direnv exec . npm test              # node --test
direnv exec . npx tsc --noEmit      # 型検査
direnv exec . npm run quality       # 型・lint・デッドコード
direnv exec . npm run build:client  # クライアントバンドル生成
direnv exec . npm run watch:client  # バンドルの watch
```

**`knot serve` の前に `npm run build:client` が必要**。
`/assets/build/*.js`（エディタ・検索・ページメニュー）は gitignore された生成物で、バンドルを作らないと編集画面・検索・操作メニューが動かない。

## 起動（クイックスタート）

CLI は `node src/cli/main.ts` で呼ぶ（`knot <command>` と読み替える）。
初回はデータディレクトリの初期化と Account 作成が必要。

```sh
direnv exec . npm run build:client

# 1. データディレクトリを初期化（./data は gitignore 済み）
direnv exec . node src/cli/main.ts init --data ./data

# 2. Account を作成（パスワードは標準入力から読む）
echo -n 'パスワード' | direnv exec . node src/cli/main.ts account add --data ./data --name ril

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
プロジェクト名には、予約語 `api`、`login`、`files`、`assets` を除き、64文字以内の半角英小文字、数字、ハイフンを使用する。
本文中の `https://scrapbox.io/files/…` 画像は取得して `data/files/` に保存し、本文を knot の `/files/…` URL に書き換える。
画像取得は 10 秒で打ち切り、`maxUploadBytes` を超える応答と画像以外の応答を拒否する。
Cosense の添付配信に使われる `storage.googleapis.com/scrapbox-file-distribute/` への 1 回のリダイレクトだけを許可し、それ以外のリダイレクトは拒否する。
取得に失敗した URL は外部 URL のまま残り、コマンド出力の `attachments` に失敗数が表示される。

あとは http://127.0.0.1:3000/notes を開くと、一覧の「新規作成」ボタンや `/notes/<タイトル>/edit` への直接アクセスでページを書ける。

## 外部エディタ同期（knot sync）

ページを「1 ページ = 1 テキストファイル」でローカルに書き出し、Emacs や Vim などの外部エディタで編集して手動 pull / push で同期できる。
`knot sync` は HTTP クライアントとして動くため、サーバと別マシンで実行してよい。

```sh
# API トークンを作る（サーバのデータディレクトリに対して実行する）
direnv exec . node src/cli/main.ts token add --data ./data --account ril --label sync

# 同期ディレクトリを初期化して初回 pull（クライアント側。dir は自動で作成される）
direnv exec . node src/cli/main.ts sync init ./wiki --url http://127.0.0.1:3000 --project notes
export KNOT_TOKEN=knot_...   # または ./wiki/.knot/token に保存して chmod 600
direnv exec . node src/cli/main.ts sync pull --dir ./wiki

# 編集して push。リモートが先に進んでいたページはスキップされるので pull してから再 push する
direnv exec . node src/cli/main.ts sync push --dir ./wiki
direnv exec . node src/cli/main.ts sync status --dir ./wiki --remote
```

`sync status` は既定ではネットワークへアクセスせず、ローカルファイルと `.knot/state.json` の差分だけを見る。
`--remote` を付けるとトークンでサーバへ問い合わせ、リモート側の新規・変更・削除も表示する。

- 削除・リネームは push で伝播しない。
  ページの削除・改名は wiki の UI で行い、pull で反映する。
  ローカルでファイルを消しても、次回 pull で元の内容が復元される。
- 競合したページ（ローカル・リモート双方が変更されている）はファイルを上書きせず、`.knot/conflicts/<pageId>/remote.txt` にリモート本文を書き出して報告する。
  手でマージしてから push するか、`knot sync push --force` で最新版に対して一度だけローカル内容を再送する。
- このテキスト形式は行メタデータ（行ごとの作成者・時刻）を持たないベストエフォートの経路。
  完全なバックアップは `knot export` / `knot backup` を使う。
- リモートでタイトルの大文字小文字だけを変更した場合、ファイル内容は更新されるがファイル名の大文字小文字は元のまま残る（v1 の既知の制限）。
- 同期ディレクトリはそのまま git 管理できる。
  ただしトークンと同期状態が入る `.knot/` は必ず gitignore する（`sync init` 実行後に案内が出る）。

運用ガイド: [docs/ops.md](docs/ops.md)

開発時に維持する安全要件: [docs/security-requirements.md](docs/security-requirements.md)

脆弱性の報告方法: [SECURITY.md](SECURITY.md)

## 外部画像の許可ホスト

外部ホストの画像はセキュリティ上 allowlist を通ったものだけ `<img>` 表示する（それ以外はリンクのまま）。
既定は `i.gyazo.com` / `gyazo.com` / `scrapbox.io`（Cosense の添付ファイル）。
追加するにはデータディレクトリの `config.json` に書く（ワイルドカードはサブドメインにだけ一致）。

```json
{ "allowedImageHosts": ["i.gyazo.com", "gyazo.com", "scrapbox.io", "lh3.googleusercontent.com"] }
```

サイト内にアップロードした添付（`/files/…`）は allowlist に関係なく表示される。

## E2E テスト（Playwright）

Playwright が使用する Chromium は Nix shell に含まれる。

```sh
direnv exec . npm run test:e2e
```

`test:e2e` は一時 data dir に seed した専用サーバ（`e2e/server.ts`）を自動起動し、`npm run build:client` を前段で実行する。

## 既知の先送り最適化

- タイトル一覧（エディタ補完・検索が使う `GET /api/pages/:project/search/titles`）はセッション内 1 回の fetch + メモリキャッシュで運用している。
  ETag による差し替えは将来最適化として先送り。
- 未確認コミットを残したままタブを閉じ、その間に他者がページをリネームした場合、再送は 404 で捨てられる（発生条件が稀なため v1 の既知の制限とする）。
