# knot 設計書

作成日: 2026-07-10
状態: 承認待ち

## 目的

**knot** は、Cosense（旧 Scrapbox）のデータ構造と記法に互換な、セルフホスト可能な OSS の wiki である。

Cosense はサービスとして優れているが、OSS ではないため、サービス終了時にはデータの受け皿を失う。
knot は Cosense のエクスポート JSON を無加工で取り込み、いつでも Cosense 互換 JSON で書き出せる「受け皿」を提供する。
同時に、行単位のデータモデル、ブラケットリンク、関連ページによる自己組織化という Cosense の設計思想を引き継ぐ。

## 要件（確定事項）

ヒアリングで確定した要件は次のとおり。

- 利用者は 2〜5 人。将来リアルタイム共同編集が必要になった場合に、作り直しなしで拡張できる設計にする。
- v1 は単一プロセス + SQLite で動かす。将来 Cloudflare Workers + D1 でも動かせるよう、ストレージ層を差し替え可能にしておく。
- 記法は Scrapbox 記法をそのまま採用する。
- Emacs や Vim などの外部エディタとの同期は v2 で実装する。v1 では、それを可能にする API だけを用意する。
- v1 はログイン必須のクローズドな wiki とする。公開モードは後から足す。
- 運用費は月 1000 円以内。自宅 PC + Cloudflare Tunnel（0 円）または格安 VPS を想定する。
- ライセンスは MIT とする。

## v1 のスコープ

実装するもの:

- 複数プロジェクト（Cosense のプロジェクトに相当する独立した wiki 空間）のホスト
- ページの閲覧（SSR）、編集（CodeMirror 6）、作成、タイトル変更、削除、ピン留め
- Scrapbox 記法のパースとレンダリング
- リンクグラフ（1-hop リンク、2-hop リンク、空リンク、逆リンク）
- 日本語対応の全文検索
- Cosense エクスポート JSON のインポートと、Cosense 互換 JSON のエクスポート
- Cosense の読み取り API と同一形状の HTTP API
- 行操作コミットによる書き込み API
- 画像などの添付ファイルのアップロード
- パスワードログインとセッション管理
- CLI（サーバ起動、ユーザー管理、インポート、エクスポート、バックアップ）

実装しないもの（設計上の拡張点は確保する）:

- リアルタイム共同編集（「将来拡張」の節を参照）
- 外部エディタ同期 CLI（同上）
- public 公開モード
- Cloudflare Workers / D1 バックエンド
- ページ履歴の UI（コミットログ自体は v1 から記録する）
- 数式の KaTeX レンダリング（v1 ではコード表示で代替する）
- 通知、ストリーム表示

## 採用アプローチと代替案

**案A+（採用）**: TypeScript + Hono + SQLite。閲覧は SSR、編集画面のみ CodeMirror 6 を載せる。
書き込みは最初から「行操作 + ページ version」を正準形式とする。
ここで**正準形式**とは、あらゆる書き込み経路（Web エディタ、全文置換 API、インポート）が最終的に帰着する唯一の表現、という意味である。

代替案とその不採用理由:

- **Go 単一バイナリ**: 配布は最も単純だが、Scrapbox 記法パーサを自作する必要があり、互換性の最難関を自前で背負う。また Cloudflare Workers への移行路が事実上閉じ、確定要件と矛盾する。
- **CRDT（Yjs）ファースト**: リアルタイム共同編集を最初から得られるが、真のデータが CRDT の内部表現になり、SQLite の行を直接読める透明性を失う。2〜5 人の利用では衝突がまれで、複雑さに見合わない。

CRDT を採用しなくても Cosense 相当のリアルタイム共同編集に到達できる根拠は、Cosense 自体が CRDT ではなく行単位の操作をサーバで直列化する方式であることによる。
行操作を正準形式にしておけば、リアルタイム化は「同じ操作を WebSocket で配信する」追加実装に収まる（「将来拡張」の節で詳述する）。

## アーキテクチャ

```
ブラウザ
 ├─ 閲覧: SSR された HTML（Hono/JSX）
 └─ 編集: CodeMirror 6（記法ハイライト、リンク補完、自動保存）
      │ HTTP (JSON)
      ▼
knot サーバ（Node.js LTS + Hono、単一プロセス）
 ├─ render:  scrapbox-parser の AST → HTML
 ├─ core:    コミットエンジン（行操作の適用、version 管理、リンク索引更新）
 ├─ storage: リポジトリ層（interface。v1 実装は node:sqlite）
 └─ 静的アセットと添付ファイルの配信
      │
      ▼
data/
 ├─ knot.db   … SQLite（全データ）
 └─ files/    … 添付ファイル
```

実行時依存は Hono、@progfay/scrapbox-parser、CodeMirror 6 の三つに限定する。
DB アクセスは Node 内蔵の node:sqlite、パスワードハッシュは Node 内蔵の scrypt を使い、ネイティブ依存を持たない。

### ソースレイアウト

```
src/
  core/     行操作、コミットエンジン、行差分、タイトル正規化、リンク抽出
  render/   AST → HTML レンダラ
  storage/  Storage interface、SQLite 実装、マイグレーション
  server/   Hono アプリ、ルーティング、認証、SSR ビュー
  client/   エディタ（CodeMirror 設定、補完、自動保存）
  cli/      knot コマンド
test/
```

core と render は I/O を持たない純粋なモジュールとし、storage と server から独立にテストできるようにする。
将来の Workers 対応で書き換えるのは storage の実装と server の起動部だけ、というのがこの分割の意図である。

## データモデル

### スキーマ

```sql
projects    (id, name UNIQUE, display_name, created, updated)
users       (id, name UNIQUE, display_name, email, password_hash, is_admin, created)
pages       (id, project_id, title, title_lc, version, pinned, created, updated,
             UNIQUE(project_id, title_lc))
lines       (id, page_id, ord, text, created, updated, user_id)
commits     (id, page_id, version, user_id, created, ops)
links       (project_id, source_page_id, target_title_lc)
attachments (id, project_id, filename, content_type, size, sha256, user_id, created)
sessions    (id, user_id, expires, created)
pages_fts   (FTS5 仮想テーブル、tokenize='trigram')
```

- タイムスタンプはすべて Unix 秒（Cosense と同じ）。
- ID は ULID で発行する。インポート時は Cosense 側の ID をそのまま保持する。
- `lines.ord` はページ内の行順。コミット適用時に振り直す。
- `commits.ops` は行操作の JSON 配列。追記のみで、v1 では読み取る UI を持たない。
- `links` はページ保存のたびに AST から抽出して張り直す導出テーブル。
- `pages_fts` はタイトルと全行を連結したテキストを索引する。trigram トークナイザにより日本語の部分一致検索が成立する。
- マイグレーションは連番 SQL ファイルを起動時に適用する方式とし、適用位置は `PRAGMA user_version` で管理する。

### タイトル正規化

**title_lc** は、タイトルを Unicode NFC 正規化し、小文字化し、空白 (U+0020) を `_` に置換した文字列である。

- リンク解決は title_lc の一致で行う。`[Foo Bar]` と `[foo_bar]` は同じページを指す。
- URL パスもこの規則で解決する（`/:project/Foo_Bar` はタイトル「Foo Bar」のページ）。
- この規則は Cosense の titleLc の観察された挙動（小文字化、空白とアンダースコアの同一視）に合わせた knot 独自の定義であり、Cosense 内部実装との完全一致は保証しない。

### 行操作とコミット

書き込みの正準形式は次の三種の**行操作**である。

```json
{"type": "insert", "id": "<新しい行ID>", "after": "<行ID> | _head", "text": "..."}
{"type": "update", "id": "<行ID>", "text": "..."}
{"type": "delete", "id": "<行ID>"}
```

**コミット**は `{commitId, baseVersion, ops[]}` の単位で適用する。

- `baseVersion` が現在の `pages.version` と一致する場合のみ、ops を配列順に単一トランザクションで適用し、version を 1 増やし、commits に追記する。
- 不一致の場合は 409 と最新のページ状態（version と全行）を返す。クライアントは最新状態に自分の未送信編集を適用し直して再送する。同一行が両者で更新されていた場合は行単位の後勝ちとする。1 行を衝突の単位とするのは Cosense と同じ粒度である。
- `commitId` はクライアントが ULID で発行する。適用済み commitId の再送は成功応答を返すのみとし（冪等）、再試行を安全にする。
- ページの先頭行はタイトルである（Cosense と同じ）。先頭行への update はタイトル変更として扱い、`pages.title` と `title_lc` を同時に更新する。title_lc の一意制約に反する場合は 409 を返す。
- ページの新規作成は「タイトル行 1 行だけの insert を含む最初のコミット」で行う。空のページ行は作らない。
- 全行削除されたページは削除済みとして扱う。

## Cosense 互換性

### 記法

パーサは @progfay/scrapbox-parser（MIT）をそのまま使う。
対応する記法はパーサが受理する全種で、主なものは次のとおり。

- ブラケットリンク `[ページ名]`、外部リンク `[URL タイトル]`、ハッシュタグ `#tag`
- 装飾 `[* 強調]` `[/ 斜体]` `[- 打ち消し]`、インラインコード、引用 `>`
- 行頭インデント（空白・タブ）による箇条書き
- `code:ファイル名` によるコードブロック、`table:名前` によるテーブル
- 画像 URL の埋め込み、アイコン `[名前.icon]`（対象ページの最初の画像を表示する）
- 数式 `[$ ...]`（v1 ではコード表示。KaTeX はスコープ外）
- 同一インスタンス内の他プロジェクトへのリンク `/project/page`

### 読み取り API

Cosense の読み取り API と同じパスと同じレスポンス形状を実装する。
Cosense の周辺ツール（エクスポータ、グラフ可視化、MCP サーバなど）はこの API に依存しているため、接続先を knot に向けるだけで動くことを互換性の柱とする。

```
GET /api/pages/:project                     ページ一覧（skip, limit, sort）
GET /api/pages/:project/:title              ページ本体（lines, links, relatedPages を含む）
GET /api/pages/:project/:title/text         プレーンテキスト
GET /api/pages/:project/:title/icon         ページアイコン（最初の画像）
GET /api/pages/:project/search/query?q=     全文検索
GET /api/code/:project/:title/:filename     コードブロック抽出
```

`relatedPages` には 1-hop リンク、2-hop リンク、逆リンクの有無を Cosense と同じ構造で含める。
形状は Cosense の公開レスポンスを観察して合わせる。フィールドの網羅は保証せず、周辺ツールが実際に参照するフィールドを優先する。

### インポートとエクスポート

- インポートは Cosense のエクスポート JSON を無加工で受け付ける。行が `{text, created, updated, userId, id}` のオブジェクト形式でも、文字列だけの簡易形式でも取り込める。行のタイムスタンプと userId は保持する。`users` 配列は表示専用ユーザー（password_hash なし、ログイン不可）として取り込む。
- タイトルが既存ページと衝突した場合の動作は、インポート時のオプションで「スキップ」「上書き」「新しい方を採用」から選ぶ。既定はスキップ。
- インポートも内部的にはコミットとして記録する。すべての書き込みが commits に残る、という不変条件を保つためである。
- エクスポートは Cosense エクスポートと同じ構造の JSON（行メタデータ込み）を出す。`?format=import` を指定すると行を文字列配列にした簡易形式で出し、Cosense のインポート機能に直接渡せる形にする。

## 書き込み API

Cosense に公式の書き込み API は存在しないため、knot 独自の API は `/api/knot/` 名前空間に分離し、互換 API と混ざらないようにする。

```
POST   /api/knot/pages/:project/:title/commits   行操作のコミット（正準経路）
PUT    /api/knot/pages/:project/:title/text      全文置換
POST   /api/knot/pages/:project/:title/rename    タイトル変更（リンク元書き換えオプション付き）
DELETE /api/knot/pages/:project/:title           ページ削除
POST   /api/knot/projects/:project/import        Cosense JSON の取り込み
GET    /api/knot/projects/:project/export        Cosense 互換 JSON の書き出し
POST   /api/knot/files                           添付アップロード
POST   /api/knot/session                         ログイン
DELETE /api/knot/session                         ログアウト
```

- `PUT .../text` は行 ID を知らないクライアント向けの簡易経路である。`{baseVersion, text}` を受け取り、サーバが現行の行と LCS 差分を取って行操作に変換し、通常のコミットとして適用する。v2 の外部エディタ同期 CLI はこの経路を使う。
- `rename` は新タイトルへの変更に加え、リンク元ページの `[旧タイトル]` を `[新タイトル]` に書き換えるかを `rewriteLinks: true` で指定できる。書き換えは各リンク元ページへの通常のコミットとして実行される。

## UI とエディタ

### 画面構成

```
GET /login                ログイン
GET /:project             ページ一覧（カードグリッド）
GET /:project/:title      ページ閲覧（SSR）
GET /:project/:title/edit 編集（CodeMirror）
```

- **ページ一覧**: カードグリッド。ピン留めが先頭、以降は更新順。カードにはタイトル、最初の画像、冒頭数行を表示する。ページングは「もっと見る」ボタンで行う。
- **ページ閲覧**: SSR で描画する。下部に関連ページ（1-hop、2-hop、このページへのリンク元）を表示する。存在しないページへのリンクは赤リンクとして描画し、クリックで新規作成に遷移する。
- **新規作成**: 赤リンクのクリック、または一覧の新規ボタンから編集画面を開く。ページの実体は最初のコミットで作られる。

### エディタ

CodeMirror 6 を使い、Scrapbox 記法のプレーンテキストを編集する。

- 記法のライブハイライト（リンク、装飾、コードブロックなどの装飾表示）
- `[` 入力で既存ページタイトルのオートコンプリート
- Tab / Shift-Tab によるインデント操作
- 画像のペーストとドロップでアップロードし、URL を挿入
- 保存ボタンは置かない。編集停止から 500ms で自動コミットする。
- エディタはロード時に行 ID を受け取り、CodeMirror の変更追跡を使って行と ID の対応を維持し、行操作を直接生成して送る。409 応答時は最新状態を取り込み、未送信の編集を適用し直して再送する。

Cosense の「常に編集モード」（閲覧と編集の区別がない UI）は v1 では再現せず、閲覧画面と編集画面を分ける。
編集画面内の体験（保存操作が存在しない、記法が即座に装飾される）で Cosense の感覚を近似する。

## 認証とセキュリティ

v1 はログイン必須のクローズドな wiki である。ログインページと静的アセット以外の全ルートで認証を要求する。

- パスワードは Node 内蔵の scrypt でハッシュする。ユーザー作成は CLI（`knot user add`）で行い、Web からのサインアップは持たない。
- セッションはランダム 128 ビットの ID をクッキーに載せる。属性は HttpOnly、Secure、SameSite=Lax。有効期限は 30 日のスライディング方式とする。
- 書き込み API はカスタムヘッダ `X-Knot-Client` を必須にする。クロスオリジンのフォーム送信はカスタムヘッダを付けられないため、SameSite=Lax と合わせて CSRF を遮断できる。
- ログイン試行は IP とユーザー名の組でレートリミットする（インメモリ、10 回/10 分）。
- CSP は既定で self のみとする。img-src だけは設定で外部ホストを許可できるようにする。Cosense からのインポートで Gyazo などの外部画像 URL が大量に入るためである。
- 添付ファイルはサイズ上限（既定 10MB、設定可能）、content-type 検証、ランダム化した保存名で扱い、`X-Content-Type-Options: nosniff` を付けて配信する。sha256 が一致する既存ファイルがあれば再利用する。

## 運用とバックアップ

- 起動は `knot serve --data ./data` の 1 コマンド。設定は環境変数またはフラグ（ポート、データディレクトリ、img-src 許可ホスト、アップロード上限）。Docker イメージも提供する。
- 必要リソースはメモリ 200MB 程度を想定する。自宅 PC + Cloudflare Tunnel なら 0 円、格安 VPS の最安プラン（月数百円）で月 1000 円以内の要件を満たす。
- バックアップは `knot backup` コマンドで行う。SQLite の backup API による knot.db のスナップショットと files/ のコピーを取る。
- それに加えて、Cosense 互換 JSON の定期自動エクスポートを設定できるようにする。DB ファイルとは独立した、データ形式に依存しない保険である。

## エラー処理

エラーは次の 3 系統に集約する。

- **409（競合）**: コミットの baseVersion 不一致、タイトルの一意制約違反。応答に最新状態を含め、クライアントが自動で取り込み直す。
- **401 / 403（認証・認可）**: 未ログインは HTML ルートではログイン画面へリダイレクト、API では 401 を返す。
- **404（不在）**: 存在しないページの閲覧 URL は、そのタイトルでの新規作成を促す画面を返す（赤リンクの遷移先と同じ）。API では 404 を返す。

それ以外の失敗（パース不能な JSON、上限超過のアップロードなど）は 400 系で個別に返し、5xx はログに集約する。

## テスト戦略

- **パーサとレンダラのゴールデンテスト**: 記法サンプル → HTML の期待値を固定し、レンダラの回帰を検出する。
- **コミットエンジンのランダム編集テスト**: ランダムな行操作列を生成して適用し、lines の整合（ord の連続性、ID の一意性）と version の単調増加を検証する。
- **実データの round-trip テスト**: 実際の Cosense エクスポート JSON をインポートし、エクスポートして、意味的な同値性（ページ数、行テキスト、タイムスタンプ、userId の保存）を確認する。
- **API の E2E**: Hono の `app.request` でルーティングから storage までを通しでテストする。
- **エディタのスモークテスト**: Playwright で「開く、編集する、自動保存される、再読み込みで内容が残る」の 1 本だけを維持する。

core と render は純粋モジュールなので、テストの大半は DB もサーバも立てずに実行できる。

## 将来拡張の設計上の対応

### リアルタイム共同編集

WebSocket エンドポイントを追加し、適用済みコミットをページ購読者へ配信する。
エディタは受信した ops を逐次適用し、自分の未確定編集をリベースする。
正準形式（行操作 + version + commits ログ）は v1 から存在するため、DB スキーマ、API、レンダラ、認証は変更しない。
変更されるのはエディタの保存層と、WS ゲートウェイの追加に限られる。
行内の文字単位の同時編集が必要になった場合に限り、そのときに Yjs の導入を検討する（CodeMirror 6 には Yjs バインディングがあり、エディタ部品は流用できる）。

### 外部エディタ同期 CLI（v2）

`PUT .../text` が同期の書き込み経路、`GET .../text` と一覧 API が読み取り経路になる。
CLI は「1 ページ = 1 テキストファイル」でローカルディレクトリに書き出し、ファイルの変更を baseVersion 付きで push する。
409 が返った場合の解決（ローカル優先、リモート優先、マージ）は CLI 側の設計課題として v2 で扱う。

### Cloudflare Workers / D1

server は Hono なのでハンドラはそのまま動く。
storage の SQLite 実装を D1 実装に差し替え、添付ファイルを R2 に置く実装を追加する。
node:sqlite と scrypt への依存は storage と auth のモジュール内に閉じ込めておく。
FTS5 trigram が D1 で使えない場合に備え、検索はストレージ interface の 1 メソッドとして抽象化しておく。

## 技術選定の根拠

検証済みの事実:

- @progfay/scrapbox-parser 10.1.1（MIT）が npm に存在し、Scrapbox 記法のパースを提供する（2026-07-10 確認）。
- Node v24.18.0 の node:sqlite（SQLite 3.53.1）で FTS5 の trigram トークナイザが動作し、日本語の部分一致検索が成立する（同日、ローカルで動作確認）。

選定理由:

- **TypeScript**: パーサ資産を直接使える唯一の言語であり、サーバとエディタを単一言語で書ける。Workers への移行路も保てる。
- **Hono**: Node、Bun、Deno、Workers で同一コードが動くことを設計目標としたフレームワークであり、「v1 は Node、将来 Workers」の方針に一致する。
- **node:sqlite + scrypt**: ランタイム内蔵機能を使うことで、ネイティブ依存のビルド問題と依存パッケージの寿命リスクを避ける。
- **CodeMirror 6**: 長期メンテナンスの実績があるエディタ基盤で、記法ハイライト、補完、変更追跡（行 ID の維持に使う）を備える。
- **SSR 主体で SPA を持たない**: 依存を減らし、ビルドの複雑さをエディタのバンドル 1 点に絞るため。
