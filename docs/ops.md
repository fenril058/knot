# knot 運用ガイド

## 1. 起動と設定

データディレクトリを初期化してからサーバを起動します。

```sh
knot init --data /srv/knot
knot serve --data /srv/knot
```

`knot serve` の構文は次のとおりです。

```text
knot serve --data <dir> [--port <n>] [--hostname <s>]
```

`--port` の既定値は `3000`、`--hostname` の既定値は `127.0.0.1` です。

`--port 0` を指定すると OS が空いているポートを割り当て、起動メッセージに実際のポートを表示します。
`--data` には `knot init` で初期化したデータディレクトリを指定します。

設定はデータディレクトリ直下の `config.json` に JSON オブジェクトとして記述します。
ファイルがない場合はすべての既定値が使われ、未知のキーや不正な値がある場合は起動に失敗します。

| キー | 既定値 | 意味 |
| --- | --- | --- |
| `allowedImageHosts` | `["i.gyazo.com", "gyazo.com", "scrapbox.io"]` | 外部画像の表示を許可するホスト名の配列です。 |
| `allowedMediaHosts` | `[]` | 外部の動画と音声の読み込みを許可するホスト名の配列です。 |
| `allowedFrameHosts` | `[]` | iframe への埋め込みを許可するホスト名の配列で、空配列では埋め込みをすべて拒否します。 |
| `maxUploadBytes` | `10485760` | アップロードまたは Cosense import で保存する添付ファイル 1 個あたりの最大バイト数で、既定値は 10 MiB です。 |
| `secureCookie` | `"auto"` | セッション Cookie に `Secure` 属性を付けるかを `true`、`false`、`"auto"` で指定します。 |
| `sessionTtlSeconds` | `2592000` | セッションの有効期間を秒単位で指定し、既定値は 30 日です。 |
| `autoExportDir` | `null` | 自動エクスポートの出力先で、`null` は無効を意味し、相対パスはデータディレクトリを基準に解決されます。 |
| `autoExportIntervalHours` | `24` | 自動エクスポートの実行間隔を時間単位で指定します。上限は 596 時間です。 |
| `autoExportKeep` | `7` | プロジェクトごとに保存する自動エクスポートの世代数です。 |

ホスト名の配列では `*.example.com` のようなワイルドカードを指定できます。
ワイルドカードはサブドメインだけに一致します。

通常運用で必要なメモリの目安は 200 MB 程度です。
ただし、`knot export --with-files` と自動エクスポートは zip をメモリ上に構築するため、実行中は対象プロジェクトの添付ファイル合計の約 3 倍（未圧縮 Buffer、圧縮 Buffer、最終 zip）と zlib の作業領域に相当するピークメモリが上乗せされます。
数 GB 規模の添付ファイルを持つ運用は v1 の対象外です。
`knot backup` はファイルのコピーと SQLite の backup API を使い、メモリ上に zip を作らないため、この上乗せの対象外です。

### Cosense import の添付画像

CLI と import API は、本文中の `https://scrapbox.io/files/…` 画像を取得してデータディレクトリの `files/` に保存します。
本文 URL は `/files/<id>/<filename>` に書き換わり、同じ SHA-256 の添付はプロジェクト内の既存レコードを再利用します。

取得は 10 秒で打ち切ります。
Cosense の添付配信に使われる `storage.googleapis.com/scrapbox-file-distribute/` への 1 回のリダイレクトだけを許可し、それ以外のリダイレクトは拒否します。
`maxUploadBytes` を超える応答、対応外の MIME type、MIME type とマジックバイトが一致しない応答も保存しません。
取得に失敗した URL は本文にそのまま残り、import 応答の `attachments.failed` に件数が入ります。
認証が必要な private プロジェクトの添付取得には対応していません。

## 2. Account とトークン

Account のパスワードは標準入力から渡します。
Account 名には英小文字、数字、アンダースコア、ハイフンを使用でき、パスワードは 8 文字以上必要です。

```sh
printf '%s' '十分に長いパスワード' | knot account add \
  --data /srv/knot --name alice --display-name 'Alice' --admin
```

`--display-name` と `--admin` は省略できます。
個人アクセストークン（PAT）は次のコマンドで発行、一覧表示、失効します。

```sh
knot token add --data /srv/knot --account alice --label cosense-cli
knot token list --data /srv/knot --account alice
knot token revoke --data /srv/knot --id <id>
```

`token add` が表示するトークンは安全な場所に保存してください。
API を直接呼ぶ場合は、PAT を `x-personal-access-token` ヘッダに指定します。

```sh
curl -H "x-personal-access-token: $KNOT_PAT" \
  https://wiki.example.com/api/pages/notes
```

`@helpfeel/cosense-cli` では PAT を `COSENSE_PAT` 環境変数に設定します。

```sh
COSENSE_PAT="$KNOT_PAT" cosense listPages https://wiki.example.com/notes
```

### Cloudflare D1 の初期化

Worker 用 D1 は `wrangler.jsonc` の `DB` binding と `src/storage/migrations/d1/` の migration を使います。
検索 index には SQLite と同じ trigram tokenizer の FTS5 virtual table を使います。
ローカル D1 は次の順に初期化します。

```sh
wrangler d1 migrations apply knot --local
KNOT_BOOTSTRAP_ACCOUNT_ID=01ACCOUNT \
KNOT_BOOTSTRAP_ACTOR_ID=01ACTOR \
KNOT_BOOTSTRAP_ACCOUNT_NAME=owner \
KNOT_BOOTSTRAP_DISPLAY_NAME=Owner \
KNOT_BOOTSTRAP_EMAIL=owner@example.com \
npm run d1:bootstrap
```

Account ID と Actor ID には異なる値を指定します。
各値は Worker secret `KNOT_ACCESS_CONFIG` の mapping と一致させます。
同じ mapping での再実行は成功し、既存 identity と衝突する mapping は失敗します。

isolated remote D1 の検証では、追跡対象の `wrangler.jsonc` を変更せず、database name、database ID、`"remote": true` を設定した一時 config を `.dev/` に作ります。
`--remote` は remote binding の利用を許可する指定であり、config の binding 自体を remote へ変更しません。
production D1 を対象にする前に、`wrangler d1 info knot` で database を確認してください。
適用後は `npm run d1:smoke -- --remote --config .dev/wrangler-d1-smoke.jsonc` で Account / Actor、project、page read、search、visit、commit / delete の競合と冪等性、および rename の逆リンク列挙 race を確認できます。
保守操作の `knot reindex` は D1 の page mutation revision guard に参加しないため、D1 のページ書き込みを止めた状態で実行します。

```sh
wrangler d1 migrations apply knot-smoke \
  --remote --config .dev/wrangler-d1-smoke.jsonc
KNOT_BOOTSTRAP_ACCOUNT_ID=01ACCOUNT \
KNOT_BOOTSTRAP_ACTOR_ID=01ACTOR \
KNOT_BOOTSTRAP_ACCOUNT_NAME=owner \
KNOT_BOOTSTRAP_DISPLAY_NAME=Owner \
KNOT_BOOTSTRAP_EMAIL=owner@example.com \
npm run d1:bootstrap -- --remote --config .dev/wrangler-d1-smoke.jsonc
```

### Cloudflare Workers の一人利用配備

`knot-dogfood` Worker は `workers.dev`、Static Assets、D1 を一つの配備として扱います。
本番設定は `wrangler.jsonc` から `.wrangler.production.jsonc` に生成し、D1 ID と Access の設定値を Git に保存しません。
生成時は `workers.dev` と preview URL を無効にします。
初回配備後に Worker 全体を Access で保護し、その後で `workers.dev` を有効にします。
公開直後に未認証の HTML、API、CSS、browser script が取得できないことを確認します。

Cloudflare にログインし、`wrangler d1 list` で `knot-dogfood` が存在しないことを確認してから D1 を作ります。
既存の同名 database がある場合は新規作成せず、ID と用途を確認します。
次の `UUID` は `d1 create` が返した database ID に置き換えます。

```sh
direnv exec . wrangler whoami
direnv exec . wrangler d1 create knot-dogfood --location apac
KNOT_D1_DATABASE_ID=UUID direnv exec . npm run prepare:production-config
direnv exec . wrangler d1 info knot-dogfood
direnv exec . wrangler d1 migrations apply knot-dogfood --remote --config .wrangler.production.jsonc
```

異なる Account ID と Actor ID を決め、Access で許可するメールアドレスを D1 に登録します。
ID とメールアドレスは Worker secret の対応付けと一致させます。
初回配備では公開 URL が無いため、Access application 作成前の `audience` に仮の文字列を使えます。
`.dev/worker-secrets.json` は Wrangler の `--secrets-file` 形式で、`KNOT_ACCESS_CONFIG` に `issuer`、`audience`、`email`、`accountId`、`actorId` を持つ JSON 文字列を入れます。
このファイルは Git 管理外に置き、権限を所有者だけにします。

```json
{
  "KNOT_ACCESS_CONFIG": "{\"issuer\":\"https://team.cloudflareaccess.com\",\"audience\":\"pending-access\",\"email\":\"owner@example.com\",\"accountId\":\"ACCOUNT_ID\",\"actorId\":\"ACTOR_ID\"}"
}
```

```sh
KNOT_BOOTSTRAP_ACCOUNT_ID=ACCOUNT_ID \
KNOT_BOOTSTRAP_ACTOR_ID=ACTOR_ID \
KNOT_BOOTSTRAP_ACCOUNT_NAME=owner \
KNOT_BOOTSTRAP_DISPLAY_NAME=Owner \
KNOT_BOOTSTRAP_EMAIL=EMAIL \
direnv exec . npm run d1:bootstrap -- --remote --config .wrangler.production.jsonc
direnv exec . npm run build:client
direnv exec . npm run prepare:worker-assets
direnv exec . wrangler deploy --dry-run --config .wrangler.production.jsonc
direnv exec . wrangler deploy --config .wrangler.production.jsonc --secrets-file .dev/worker-secrets.json
```

Cloudflare dashboard の Workers & Pages で `knot-dogfood` の Access tab を開き、`All traffic` を選びます。
一人のメールアドレスだけを Allow policy に指定し、`Everyone`、メールドメイン全体、`One-time PIN` のみを含む Allow rule は作りません。
Access application の audience と team domain を確認し、`.dev/worker-secrets.json` の `audience` と `issuer` を実値へ更新して再配備します。
`issuer` は `https://<team>.cloudflareaccess.com` 形式です。
その後、同じ D1 ID で公開設定を再生成して配備します。

```sh
KNOT_D1_DATABASE_ID=UUID direnv exec . npm run prepare:production-config -- --enable-workers-dev
direnv exec . wrangler deploy --config .wrangler.production.jsonc --secrets-file .dev/worker-secrets.json
```

公開 URL で Access を通過する前に `/`、`/api/pages/<project>`、`/assets/app.css`、`/assets/build/editor.js` を取得できないことを外部から確かめます。
Access にログインした browser の storage state を `.dev/access-state.json` に保存し、次の smoke を実行します。
smoke は browser ごとに別 project と sentinel page を作り、出力した page ID、version、本文を deploy 前後で比較するために保持します。
実行のたびに作られた project と page は D1 に残ります。
実機 smartphone でも同じ URL から project、page、編集、保存、再読み込み、検索を確認します。

```sh
KNOT_PRODUCTION_URL=https://<worker>.<subdomain>.workers.dev \
direnv exec . npm run smoke:production
```

新 version の deploy 後、保存した sentinel page の ID、version、本文、検索結果が変わらないことを確認し、追加編集を保存します。
確認が終わった smoke 用 project は、D1 に残る名前を列挙してから削除できます。
sentinel の project 名は smoke の出力にもありますが、競合テスト用 project 名は D1 の一覧から調べます。
列挙結果に含まれる各 project について、詳細照会の `PROJECT_NAME` を正確な名前に置き換えて page を確認します。

```sh
direnv exec . wrangler d1 execute knot-dogfood --remote \
  --config .wrangler.production.jsonc \
  --command "SELECT name FROM projects WHERE name LIKE 'dogfood-smoke-%' OR name LIKE 'dogfood-conflict-%'" \
  --yes
direnv exec . wrangler d1 execute knot-dogfood --remote \
  --config .wrangler.production.jsonc \
  --command "SELECT p.name, g.title FROM projects p LEFT JOIN pages g ON g.project_id = p.id WHERE p.name = 'PROJECT_NAME'" \
  --yes
```

確認した正確な名前で削除 SQL の `PROJECT_NAME` を置き換え、`.dev/cleanup-dogfood-smoke.sql` に保存します。
削除する project ごとに実行し、他の project 名を含む広い条件には置き換えません。

```sql
DELETE FROM pages_fts WHERE page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM page_visits WHERE page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM links WHERE source_page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM commits WHERE page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM title_history WHERE page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM lines WHERE page_id IN (SELECT id FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME'));
DELETE FROM pages WHERE project_id = (SELECT id FROM projects WHERE name = 'PROJECT_NAME');
DELETE FROM projects WHERE name = 'PROJECT_NAME';
```

```sh
direnv exec . wrangler d1 execute knot-dogfood --remote \
  --config .wrangler.production.jsonc \
  --file .dev/cleanup-dogfood-smoke.sql --yes
```

初期利用量は Workers dashboard の request 数と CPU time、D1 dashboard の rows read、rows written、storage を読み、issue に観測値を記録します。
Cloudflare Free の上限は変更されるため、配備時点の [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) と [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) で比較します。

重要データは D1 以外にも保管します。
D1 の全体 export は FTS5 仮想テーブルがあると失敗するため、通常テーブルを指定して SQL を取得します。
CI はこの手順の export と復元のテーブル一覧を D1 migration 適用後の通常テーブルと照合します。
次のコピーは D1 とは別のローカルディスク上に保存し、所有者だけが読める権限にします。

```sh
direnv exec . wrangler d1 export knot-dogfood --remote \
  --config .wrangler.production.jsonc \
  --table accounts --table actors --table commits --table d1_migrations \
  --table lines --table links --table page_mutation_guard \
  --table page_mutation_revisions --table page_visits --table pages \
  --table projects --table title_history \
  --output .dev/knot-dogfood-data.sql --skip-confirmation
chmod 600 .dev/knot-dogfood-data.sql
```

この SQL に FTS5 の検索 index と SQLite index は含まれません。
2026-09-17 に隔離した local D1 で migration、通常テーブルの import、reindex を行い、同じ page ID の read と search が復旧することを確認しました。
検証時は次の手順で dump の schema と `d1_migrations` のデータを除き、新規 DB に migration を先に適用しました。
`.dev/restore-state` は未使用の場所を指定し、既存の local D1 の状態と混ぜません。

```sh
umask 077
sqlite3 .dev/restore-extract.sqlite < .dev/knot-dogfood-data.sql
sqlite3 .dev/restore-extract.sqlite \
  '.dump --data-only actors accounts projects pages lines commits title_history links page_visits page_mutation_guard page_mutation_revisions' \
  > .dev/restore-data.sql
direnv exec . wrangler d1 migrations apply knot --local \
  --config wrangler.jsonc --persist-to .dev/restore-state
direnv exec . wrangler d1 execute knot --local \
  --config wrangler.jsonc --persist-to .dev/restore-state \
  --file .dev/restore-data.sql --yes
direnv exec . node scripts/reindex-d1.ts \
  --config wrangler.jsonc --persist-to .dev/restore-state
```

復元先の page read と search を元の ID・本文・検索結果と照合します。
remote D1 へ復元する場合は書き込みを止め、新しい DB で migration、通常テーブルの import、`node scripts/reindex-d1.ts --remote --config <復元先の設定>`、page read と search の順に確認してから切り替えます。
remote D1 への復元と切り替え自体は未検証です。
この別コピーは完全な backup / restore の保証にはならず、Time Travel も別コピーの代わりにはなりません。
attachment、import、local editor sync はこの配備では扱いません。

## 3. リバースプロキシ

リバースプロキシは `/files/` と `/assets/` を含むすべてのパスを knot に転送します。
HTTPS を終端する場合は、バックエンドへ `X-Forwarded-Proto` を渡します。

nginx の設定例は次のとおりです。
この例の `client_max_body_size` は、`maxUploadBytes` の既定値 10 MiB と multipart オーバーヘッド 64 KiB を受け入れられる値にしています。

```nginx
server {
    listen 443 ssl;
    server_name wiki.example.com;

    client_max_body_size 11m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`maxUploadBytes` を変更した場合は `client_max_body_size` も `maxUploadBytes` と multipart オーバーヘッドの合計より大きくします。
`location /` を使うことで、API、ページ、`/files/`、`/assets/` をまとめて転送します。

Caddy の設定例は次のとおりです。
Caddy の `reverse_proxy` は受信したプロトコルに基づく `X-Forwarded-Proto` を既定で設定しますが、ここでは要件を明示するために指定しています。

```caddyfile
wiki.example.com {
    request_body {
        max_size 11MiB
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
    }
}
```

`request_body` ディレクティブを利用できるかは Caddy のバージョンに依存するため、使用するバージョンの公式ドキュメントで確認してください。

`secureCookie: "auto"` は `X-Forwarded-Proto` ではなく、`knot serve` に渡した `--hostname` だけで解決されます。
hostname が `127.0.0.1`、`localhost`、`::1` のいずれかなら `false`、それ以外なら `true` になります。
したがって、リバースプロキシが HTTPS を終端し、HTTP で loopback のバックエンドへ接続する構成では、`--hostname 127.0.0.1` と `secureCookie: true` を組み合わせます。
コンテナなどで `--hostname 0.0.0.0` を使う場合は `"auto"` が `true` になるため、HTTPS 終端配下ではそのまま使用できます。
HTTP だけで公開する検証環境で `--hostname 0.0.0.0` を使う場合は、Cookie を送信できるよう `secureCookie: false` を明示します。

ログイン試行のレートリミットは、接続元の socket アドレスとユーザー名の組み合わせをキーにし、10 分間に 10 回まで許可します。
`X-Forwarded-For` は解釈しないため、リバースプロキシや Cloudflare Tunnel の配下では全利用者が同じ接続元アドレスを共有します。
この構成では、ある利用者が同じユーザー名で 10 回失敗すると、全利用者がそのユーザー名で最大 10 分間ロックアウトされる可能性があります。
trusted proxy への対応は v2 の検討事項です。

## 4. Cloudflare Tunnel

自宅 PC で動かす knot を Cloudflare Tunnel から公開する場合は、knot を loopback で起動します。

```sh
knot serve --data /srv/knot --hostname 127.0.0.1 --port 3000
```

`cloudflared` の設定例は次のとおりです。

```yaml
tunnel: 00000000-0000-0000-0000-000000000000
credentials-file: /home/alice/.cloudflared/00000000-0000-0000-0000-000000000000.json

ingress:
  - hostname: wiki.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Cloudflare が HTTPS を終端し、knot への接続は HTTP になるため、`config.json` には `{"secureCookie": true}` を設定します。
この構成にも前節のレートリミットの制約が適用されます。

## 5. バックアップと復元

バックアップ先には、未存在のディレクトリを指定します。
その親ディレクトリは先に作成し、データディレクトリ自身、その親、その子は指定しないでください。

```sh
mkdir -p /srv/knot-backups
knot backup --data /srv/knot --out /srv/knot-backups/2026-07-18
```

`knot backup` は最初に `files/` と存在する場合の `config.json` をコピーし、次に SQLite の backup API で `knot.db` のスナップショットを作り、最後に DB が参照する添付ファイルがすべてコピー済みか検証します。
ファイルを先にコピーすることで、後から作る DB スナップショットに記録された添付ファイルがバックアップ内に存在する状態を作ります。

稼働中のサーバへバックアップを実行すると、添付ファイルのアップロードと競合して検証に失敗することがあります。
この失敗は再実行すれば解決し、処理可能な失敗では部分出力は残りません。
SIGKILL や電源断では `.knot-backup-*` 一時ディレクトリが残ることがありますが、手動で削除して構いません。

バックアップ対象は `files/`、`knot.db`、存在する場合の `config.json` だけです。
自動エクスポートの zip は含まれません。

バックアップから一時的に起動する場合は、バックアップディレクトリをそのまま `--data` に指定できます。

```sh
knot serve --data /srv/knot-backups/2026-07-18
```

本番環境を復元する場合は knot を停止し、現在のデータディレクトリを退避してから、バックアップディレクトリで置き換えます。
復元後は置き換えたディレクトリを `--data` に指定して起動します。

毎日 3 時にバックアップする cron の例は次のとおりです。
出力先名が日ごとに変わり、既存ディレクトリと衝突しないようにしています。

```cron
0 3 * * * /usr/local/bin/knot backup --data /srv/knot --out /srv/knot-backups/$(date +\%F) >>/var/log/knot-backup.log 2>&1
```

## 6. 定期自動エクスポート

自動エクスポートは、SQLite の DB 形式に依存しない保険として、プロジェクトごとの JSON と添付ファイルを zip に保存します。
次の例では 24 時間ごとに実行し、プロジェクトごとに 7 世代を残します。

```json
{
  "autoExportDir": "/srv/knot-exports",
  "autoExportIntervalHours": 24,
  "autoExportKeep": 7
}
```

`autoExportDir` にはデータディレクトリの外にある絶対パスを推奨します。
データディレクトリ内に置くと、データディレクトリの障害から独立した保全にならないためです。
設定を有効にすると起動時に一度実行し、その後は指定した間隔で実行します。

各 zip には `<project>.json` と `files/` 以下の添付ファイルが入ります。
JSON は `knot export` の通常形式であり、knot への再インポート専用形式ではありません。
Cosense にページを持ち込む場合は、添付なしの `knot export --format import` で Cosense のインポート用 JSON を別途生成します。

```sh
knot export --data /srv/knot --project notes --format import --out notes-import.json
```

zip 内の JSON 本文にある添付 URL は knot の相対 URL のままです。
Cosense へのファイル移行と本文中の URL 書き換えは自動化しません。
`files/` は添付ファイルの保全と手動移行に使うもので、zip からの自動復元機能はありません。
knot 全体の復元には `knot backup` を使います。

## 7. git 管理と組み合わせた持ち出し（knot sync）

`knot sync`（Emacs や Vim など外部エディタ向けの同期 CLI）の同期ディレクトリをそのまま git リポジトリにすると、「clone して `knot sync push` で復元する」というファイルベースの持ち出し経路になります。

`.knot/`（トークン・同期 state・競合コピーが入るディレクトリ）は必ず gitignore してください。
`knot sync init` はこの手順を初期化時に案内します。

この経路が運ぶのはページ本文のテキストのみです。
行メタデータ（行ごとの作成者・時刻）と添付ファイルは含まれないため、災害復旧の正本には引き続き `knot backup` と定期自動エクスポート（前節の `autoExportDir`）を使ってください。

別サーバへ持ち込む場合は、新サーバで `knot sync init` してから既存のファイル群を配置し `knot sync push` を実行します。
サーバ側に同名ページが無い前提のため、すべて新規ページとして作成されます。

## 8. Docker 運用

named volume を作成し、初期化、Account 作成、サーバ起動の順に実行します。

```sh
docker build -t knot:latest .
docker volume create knot-data
docker run --rm -v knot-data:/data knot:latest init --data /data
printf '%s' '十分に長いパスワード' | docker run --rm -i \
  -v knot-data:/data knot:latest account add --data /data --name alice --admin
docker run -d --name knot --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v knot-data:/data knot:latest
```

イメージの既定コマンドは `serve --data /data --port 3000 --hostname 0.0.0.0` です。
この起動例はホストの loopback だけにポートを公開するため、前節までのリバースプロキシまたは Tunnel と組み合わせます。

同じ構成を Docker Compose で管理する例は次のとおりです。
初期化とユーザー作成は、上の `docker run` または `docker compose run --rm` で最初に一度だけ実行します。

```yaml
services:
  knot:
    image: knot:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - knot-data:/data

volumes:
  knot-data:
```

イメージを更新する場合は新しいイメージを取得またはビルドし、コンテナを再作成します。
データは named volume に残りますが、更新前に `knot backup` を実行してください。

```sh
docker compose pull
docker compose up -d --force-recreate
```

ローカルでビルドする構成では、`docker compose pull` の代わりに `docker build -t knot:latest .` を実行します。
bind mount を使う場合は、ホスト側データディレクトリの所有者をコンテナ内の `node` ユーザーと同じ uid 1000 に合わせる必要があります。
named volume は初回マウント時にイメージ内の `/data` の所有権を引き継ぐため、この作業は不要です。

```sh
sudo chown -R 1000:1000 /srv/knot
```

## 9. 互換性の約束

knot は次の周辺ツールと操作を受け入れテストで確認しています。
互換性はレスポンスの全フィールドを網羅することを保証せず、受け入れテストが参照する範囲を保証します。

### scrapbox-cosense-mcp 0.10.x

`scrapbox-cosense-mcp@0.10.x` では `list_pages`、`get_page`、`search_pages` の動作を確認しています。
接続先は `API_DOMAIN` にスキームを付けずに指定し、ブラウザの `connect.sid` Cookie の値を `COSENSE_SID` に設定します。
対象プロジェクトは `COSENSE_PROJECT_NAME` に設定します。

```sh
API_DOMAIN=wiki.example.com \
COSENSE_PROJECT_NAME=notes \
COSENSE_SID='<connect.sid の値>' \
npx scrapbox-cosense-mcp
```

### @helpfeel/cosense-cli 1.10.x

`@helpfeel/cosense-cli@1.10.x` では `listPages`、`readPage`、`searchFullText` の動作を確認しています。
`knot token add` で発行した PAT を `COSENSE_PAT` に設定し、プロジェクト URL を引数に渡します。

```sh
export COSENSE_PAT='<knot の PAT>'
cosense listPages https://wiki.example.com/notes
cosense readPage https://wiki.example.com/notes/PageTitle
cosense searchFullText https://wiki.example.com/notes '検索語'
```

検索語は空白区切りで AND 条件になり、先頭に `-` を付けると除外条件、二重引用符で囲むと空白を含むフレーズになります。

検索クエリは 1000 コードポイント、検索語と除外語の合計は 32 個までです。
