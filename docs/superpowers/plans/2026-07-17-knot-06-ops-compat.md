# knot plan-06 (ops-compat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Save location:** this plan should be committed to `docs/superpowers/plans/2026-07-17-knot-06-ops-compat.md` before execution (writing-plans convention for this repo).
>
> **計画の書き方（plan-04 errata の教訓を適用）:** 本計画はコピー用の実装コードを含まない。
> 各タスクはインターフェース + 挙動仕様 + テスト仕様で指定し、実装の細部は実行者が既存コードの慣例に合わせて書く。
> 例示のコード断片は「形状の説明」であり、そのまま貼ることを意図しない。

**Goal:** 配布可能な knot v1。
バックアップ/復元とその自動テスト、Cosense 互換 JSON の定期自動エクスポート（zip、添付同梱）、周辺ツール 2 つ（MCP サーバとエクスポート系公式 CLI）の受け入れテスト、Docker イメージ、GitHub Actions CI、運用ドキュメント（プロキシ設定例を含む）を納品する。

**Architecture:**
バックアップは「files/ を先にコピー → SQLite backup API で knot.db スナップショット → DB が参照する全添付の存在検証」の順序を CLI コマンド `knot backup` として実装する（設計書 27 の手順）。
定期エクスポートは `knot export --with-files`（zip）を核とし、serve プロセス内のタイマーが全プロジェクトを世代管理付きで書き出す。
zip は実行時依存を増やさないため `node:zlib` の raw deflate + 自前 CRC32 の最小ライタを実装する（読み取りはテスト専用ヘルパ）。
周辺ツール受け入れテストは「互換性の約束 = 動作保証する周辺ツールの列挙」（設計書 16）の実体である。
MCP サーバは `scrapbox-cosense-mcp`（`API_DOMAIN` で接続先変更可、`COSENSE_SID`＝connect.sid で認証）を HTTPS 起動した knot に向ける。
エクスポート系は Cosense 運営元の公式 CLI `@helpfeel/cosense-cli`（任意 origin 指定可、`x-personal-access-token` ヘッダ認証）を採用し、その前提として knot に PAT（Personal Access Token）認証と不足 2 エンドポイント（`/api/pages/v2/:project/:title`、`/api/projects/:project/users`）を追加する（2026-07-17 のユーザー決定）。

**Tech Stack:** node:sqlite の `backup()`、node:zlib（deflateRawSync / inflateRawSync）、node:crypto（sha256）、@hono/node-server（HTTPS は `createServer` + `serverOptions` オプション）、devDependencies として `scrapbox-cosense-mcp` / `@modelcontextprotocol/sdk` / `@helpfeel/cosense-cli`、Docker（node:24-slim 多段ビルド）、GitHub Actions。

**採用ツールの調査結果（2026-07-17 時点）:**

- `scrapbox-cosense-mcp@0.7.3`（worldnine 作）: 接続先は env `API_DOMAIN`（既定 scrapbox.io）、認証は env `COSENSE_SID` を `Cookie: connect.sid=<sid>` として送る。knot のセッション cookie と同名・同形式なのでそのまま通る。URL は `https://` 固定のため、テストでは knot を自己署名証明書で HTTPS 起動し、子プロセスに `NODE_EXTRA_CA_CERTS=<証明書パス>` を与えてその証明書を信頼させる（TLS 検証は無効化しない）。読み取り系ツールは `get_page {pageTitle}` / `list_pages` / `search_pages {query}`。
- `@helpfeel/cosense-cli@1.10.0`: 各コマンドが `<projectUrl>`（例 `http://127.0.0.1:4000/sandbox`）を引数に取り、http origin も受け付ける。認証は env `COSENSE_PAT` の値を `x-personal-access-token` ヘッダで送る。`listPages` は `/api/pages/:project` と `/api/projects/:project/users` を、`readPage` は `/api/pages/v2/:project/:title` と `/api/projects/:project/users` を、`searchFullText` は `/api/pages/:project/search/query` を叩く。`/api/projects/:project/users` が 404 だと listPages / readPage とも失敗する（ユーザー解決が必須経路）。bin 実体はパッケージの package.json `bin` フィールドから解決する（Node >= 24、tsx 経由。`.bin/` shim は OS 依存のため直接使わない）。

## Global Constraints

- Node.js >= 24。サーバコードは type stripping のみでビルドしない。クライアントバンドルだけが Rolldown を使う。
- 実行時依存（dependencies）は hono、@hono/node-server、@progfay/scrapbox-parser、CodeMirror 6 系のみ。本計画で dependencies は増やさない（zip・CRC32・sha256 は Node 組み込みで書く）。devDependencies の追加は可。
- テストは node:test + node:assert/strict。`npm test`（glob `test/**/*.test.ts`）で全テストが走る。Playwright は `e2e/*.spec.ts` のまま交差させない。
- タイムスタンプは Unix 秒。ID は ULID（`src/core/id.ts` の `ulid`）。
- 各コミット前に `direnv exec . npm test`、`direnv exec . npx tsc --noEmit`、`direnv exec . npm run lint` をすべて通す。クライアントに触れるタスクはなし（build:client は CI タスクでのみ関与）。
- devDependency を追加したら `npm install` で package-lock.json を更新し、nix（importNpmLock）の dev shell を `direnv reload` で再構築してから作業を続ける。
- 既存ヘルパを再実装しない: `makeServer` / `loginAs` / `seedPage`（test/helpers）、`openDatabase` / `migrate`、`SqliteStorage`、`exportCosense`、`importCosense`、`hashPassword` / `verifyPassword`、`jsonError` / `resolveProject` / `resolvePage`、`ulid`。
- エラー系統は既存の 3 系統（409 / 401・403 / 404、その他 400 系）に従う。CLI の失敗は `CliError` で表現し exit code 1。
- Markdown 文書（docs/ops.md 含む）は一文ごとに改行し、段落は空行で区切る。

---

### Task 1: PAT 認証（api_tokens テーブル + ヘッダ認証 + knot token CLI）

**Files:**
- Create: `src/storage/migrations/0004_api_tokens.sql`
- Create: `src/server/apiToken.ts`
- Modify: `src/storage/types.ts`（型と Storage インターフェース）
- Modify: `src/storage/sqlite.ts`（メソッド実装）
- Modify: `src/server/app.ts`（認証ミドルウェア）
- Modify: `src/cli/commands.ts`, `src/cli/main.ts`（token サブコマンド）
- Test: `test/storage/api-tokens.test.ts`, `test/server/pat-auth.test.ts`, `test/cli/token.test.ts`

**Interfaces:**
- Consumes: `SqliteStorage` / `openDatabase` / `migrate`（既存）、`AuthUser`（types.ts）、`makeServer`（test/helpers/server.ts）。
- Produces:
  - migration `0004_api_tokens.sql`: `api_tokens (id TEXT PK, user_id TEXT NOT NULL, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL)`。
  - `src/server/apiToken.ts`: `generateApiToken(): { token: string; tokenHash: string }`（`knot_` + randomBytes(24) の base64url、hash は sha256 hex）と `hashApiToken(token: string): string`。
  - types.ts: `type ApiToken = { id: string; userId: string; label: string; created: number }`。
  - Storage 追加メソッド:
    - `createApiToken(token: { id: string; userId: string; label: string; tokenHash: string; created: number }): Promise<void>`
    - `getUserByApiTokenHash(tokenHash: string): Promise<AuthUser | null>`（users と JOIN）
    - `listApiTokens(userId: string): Promise<ApiToken[]>`
    - `deleteApiToken(id: string): Promise<boolean>`（削除したら true）
  - CLI: `knot token add --data <dir> --user <name> [--label <s>]`（発行したトークンを標準出力に 1 度だけ表示。label 既定は `default`）、`knot token list --data <dir> --user <name>`（id / label / created を表示。token_hash は表示しない）、`knot token revoke --data <dir> --id <id>`。

**挙動仕様:**
- app.ts の共通認証ミドルウェアで、requestClass が `api` の場合のみ `x-personal-access-token` ヘッダを見る。
- ヘッダが存在すれば cookie セッションより先に評価し、`hashApiToken` で引いたユーザーが見つかれば `userId` を設定して通す。見つからなければ 401（cookie へのフォールバックはしない。誤ったトークンの黙認を防ぐ）。
- PAT 認証ではセッション cookie の発行・更新は行わない。
- `token add` は存在しないユーザー名なら CliError。password_hash なしの表示専用ユーザーにも発行しない（ログイン可能ユーザーのみ）。

- [ ] **Step 1: 失敗するテストを書く**

test/storage/api-tokens.test.ts:
- 発行 → `getUserByApiTokenHash` で AuthUser が引ける。
- 未知の hash は null。
- `listApiTokens` が発行順に返り、`deleteApiToken` 後は引けない・list からも消える。
- 同一 token_hash の二重 INSERT が UNIQUE 制約で失敗する。

test/server/pat-auth.test.ts（makeServer 使用。storage に直接 createApiToken で仕込む）:
- `x-personal-access-token` 付き GET `/api/pages/:project` が cookie なしで 200。
- 不正トークンは 401（有効な cookie を同時に送っても 401 になること）。
- HTML ルート（`/`）にヘッダを付けても無視され、ログインへリダイレクトされる。

test/cli/token.test.ts（cli.test.ts の execFileSync / runXxx パターンに従う）:
- `user add` 済みユーザーへ `token add` → 出力に `knot_` プレフィックスのトークン。
- そのトークンの hash で `getUserByApiTokenHash` が引ける。
- `token list` に label が出て token 本体は出ない。`token revoke` 後は認証が通らない。
- 未知ユーザーへの `token add` は exit code 1。

- [ ] **Step 2: テストが落ちることを確認する**

Run: `direnv exec . node --test test/storage/api-tokens.test.ts test/server/pat-auth.test.ts test/cli/token.test.ts`
Expected: メソッド不在 / migration 不在で FAIL。

- [ ] **Step 3: 実装する**

migration → apiToken.ts → sqlite.ts メソッド → app.ts ミドルウェア → CLI の順。
app.ts の変更は既存の共通認証ミドルウェア内に PAT 分岐を足すだけに留める（classifyRequest は変更しない）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test` / `direnv exec . npx tsc --noEmit` / `direnv exec . npm run lint`
Expected: 全部 PASS（既存テストの回帰なし）。

- [ ] **Step 5: コミット**

`feat(server): Personal Access Token 認証と knot token コマンドを追加`

---

### Task 2: 互換読み取り API の追加（/api/pages/v2 と /api/projects/:project/users）

**Files:**
- Modify: `src/server/routes/read.ts`
- Test: `test/server/read-v2.test.ts`, `test/server/project-users.test.ts`

**Interfaces:**
- Consumes: `storage.listUsersForProject(projectId)`（既存）、既存の `/api/pages/:project/:title` ハンドラのレスポンス組み立て。
- Produces:
  - `GET /api/pages/v2/:project/:title`: v1 の `/api/pages/:project/:title` と同一 JSON を返す（ハンドラ本体を関数に括り出して両ルートに登録する。重複実装しない）。
  - `GET /api/projects/:project/users`: `{ projectName, users: [{ id, name, displayName }] }`。未知プロジェクトは 404。

**挙動仕様（互換契約の固定）:**
採用バージョン `@helpfeel/cosense-cli@1.10.0` のソース調査（2026-07-17）に基づき、CLI が実際に参照する必須フィールドを契約として固定する。受け入れテスト（Task 8）で失敗しても、この契約の範囲を超える形状変更は行わない。

- `GET /api/pages/:project`（既存 v1）: top-level `count: number` と `pages: 配列`。pages 要素のフィールドは CLI 側が寛容に読む（欠けは許容）。
- `GET /api/pages/v2/:project/:title`: JSON オブジェクトであること。`persistent: boolean`、`lines: [{ text, id?, userId?, created?, updated? }]`、`user` / `lastUpdateUser` / `users` は**任意**（CLI は `?? []` / null 許容で読む）。よって v1 の `/api/pages/:project/:title` と同一 JSON で契約を満たす。フィールドの追加豪華化はしない（YAGNI）。
- `GET /api/projects/:project/users`: JSON オブジェクトであること。`users: [{ id, name, displayName }]` を返す（CLI はユーザー表示名の解決に使う。空配列でも動くが、knot は listUsersForProject の結果を返す）。このエンドポイントが 404 だと CLI の listPages / readPage が失敗するため、契約の一部である。
- `GET /api/pages/:project/search/query`（既存 v1）: 現行形状のまま。
- どちらの新エンドポイントも認証必須の api クラス（Task 1 の PAT でもアクセス可能）。

- [ ] **Step 1: 失敗するテストを書く**

test/server/read-v2.test.ts:
- seedPage したページについて、`/api/pages/:project/:title` と `/api/pages/v2/:project/:title` のレスポンス JSON が deepEqual。
- v2 でも未知ページ 404、未認証 401。

test/server/project-users.test.ts:
- インポート由来の表示ユーザーとログインユーザーが users に載る（id / name / displayName のみ。email や passwordHash が漏れない）。**前提条件に注意**: 現行 `listUsersForProject` はそのプロジェクトの行・コミットに現れるユーザーだけを返すため、ログインユーザーは事前にそのプロジェクトへ書き込ませておく（seedPage の userId に使う等）。
- 未知プロジェクト 404。PAT 認証でも 200（Task 1 の storage 直接発行を利用）。

- [ ] **Step 2: 落ちることを確認 → Step 3: 実装 → Step 4: 全テスト・型・lint PASS**

Run: `direnv exec . node --test test/server/read-v2.test.ts test/server/project-users.test.ts` → 実装 → `direnv exec . npm test` ほか全部 PASS。

- [ ] **Step 5: コミット**

`feat(server): Cosense 互換の /api/pages/v2 と /api/projects/:project/users を追加`

---

### Task 3: 最小 ZIP ライタ（依存追加なし）

**Files:**
- Create: `src/storage/zip.ts`
- Create: `test/helpers/zip.ts`（テスト専用リーダ）
- Test: `test/storage/zip.test.ts`

**Interfaces:**
- Produces:
  - `src/storage/zip.ts`: `type ZipEntry = { name: string; data: Buffer; mtime: number }`（mtime は Unix 秒）と `createZip(entries: ZipEntry[]): Buffer`。
  - `test/helpers/zip.ts`: `readZip(buf: Buffer): { name: string; data: Buffer }[]`（central directory を辿り inflateRawSync で展開、CRC32 検証込み）。

**挙動仕様:**
- ローカルファイルヘッダ + central directory + EOCD の最小構成。圧縮メソッドは 8（deflate、`zlib.deflateRawSync`）。CRC32 はテーブル方式で自前実装（writer と reader で共用してよい）。
- ファイル名は UTF-8 とし、general purpose bit 11（language encoding flag）を立てる。
- DOS 時刻は mtime（Unix 秒、UTC）から変換する。範囲外は clamp（1980-01-01 未満 → 1980-01-01、2107-12-31 超 → 2107-12-31）、秒は偶数へ切り下げる（DOS 時刻は 2 秒粒度）。エントリと mtime が同じなら出力はバイト単位で決定的。
- ZIP64 は実装しない。非対応範囲は黙って切り詰めず **StorageError で拒否する**: エントリ数 > 65535、エントリの非圧縮サイズ・圧縮後サイズ・ローカルヘッダ offset・central directory のサイズ/offset のいずれかが 0xFFFFFFFF 超。
- 上限検査は数値を引数に取る小さな検証関数（例 `assertZipLimits`）に括り出し、4GB の実バッファを作らずに単体テストできるようにする。
- createZip は zip 全体をメモリ上に構築する（v1 の割り切り。ストリーミング化は将来課題としてコメントに明記）。

- [ ] **Step 1: 失敗するテストを書く**

test/storage/zip.test.ts:
- 2 エントリ（テキストと 0 バイト）を createZip → readZip で round-trip、名前・内容一致。
- 日本語ファイル名（`日本語/添付.png` のようなスラッシュ入り）が round-trip する。
- 同一入力・同一 mtime で 2 回 createZip した Buffer が equal（決定性）。
- data を 1 バイト改竄した zip を readZip すると CRC 不一致で throw。
- マジックナンバー確認: 出力先頭 4 バイトが `PK\x03\x04`、末尾に EOCD シグネチャ `PK\x05\x06` が存在する。
- 上限: 65536 エントリ（全部 0 バイトで可）の createZip が StorageError。検証関数の数値テストで 0xFFFFFFFF 境界（ちょうど / +1）の合否を確認。
- DOS 時刻境界: 1980 年未満と 2107 年超の mtime が clamp され、奇数秒が偶数へ切り下がる（readZip またはヘッダのバイト検査で確認）。

- [ ] **Step 2: 落ちることを確認 → Step 3: 実装 → Step 4: PASS 確認**

Run: `direnv exec . node --test test/storage/zip.test.ts` → 実装 → `direnv exec . npm test` ほか全部 PASS。
追加検証（任意、環境に unzip があれば）: createZip 出力を一時ファイルに書き `unzip -t` が OK を返す。

- [ ] **Step 5: コミット**

`feat(storage): 依存なしの最小 ZIP ライタを追加`

---

### Task 4: knot export --with-files（添付同梱 zip）

**Files:**
- Create: `src/storage/exportZip.ts`
- Modify: `src/storage/types.ts` + `src/storage/sqlite.ts`（`listAttachments` 追加）
- Modify: `src/cli/commands.ts`, `src/cli/main.ts`（`--with-files` フラグ）
- Test: `test/storage/export-zip.test.ts`, `test/cli/export-with-files.test.ts`

**Interfaces:**
- Consumes: `exportCosense`（既存）、`createZip`（Task 3）、`Attachment` 型。
- Produces:
  - Storage 追加メソッド: `listAttachments(projectId: string): Promise<Attachment[]>`（created 昇順）。
  - `src/storage/exportZip.ts`: `buildExportZip(storage: Storage, dataDir: string, projectName: string, now: number): Promise<Buffer>`。
  - CLI: `knot export --data <dir> --project <name> --with-files --out <file.zip>`。

**挙動仕様:**
- zip の内容: `<projectName>.json`（full フォーマットの exportCosense を 2 スペースインデントで JSON 化、mtime=now）+ プロジェクトの各添付を `files/<attachment.id>` として同梱（mtime=attachment.created）。
- DB に載っている添付の実ファイルが `dataDir/files/` に無ければ StorageError（バックアップの整合性保証と同じ思想。黙って欠けた zip を作らない）。
- CLI 側: `--with-files` は `--out` 必須（zip バイナリを標準出力に流さない）。`--format import` との併用は usage エラー。出力後 `exported N pages and M files to <out>` を表示。

- [ ] **Step 1: 失敗するテストを書く**

test/storage/export-zip.test.ts（tmp dir + SqliteStorage(file or :memory:) + dataDir/files を手で用意）:
- ページ 2 件 + 添付 2 件を仕込み buildExportZip → readZip で `<project>.json` が parse でき pages 数一致、`files/<id>` の内容一致。
- 添付レコードはあるが実ファイル欠落 → reject（StorageError）。
- 未知プロジェクト → reject。

test/cli/export-with-files.test.ts:
- init → import fixture → 添付（storage.createAttachment + files/<id> 書き込み）→ `knot export --with-files --out x.zip` が成功し zip が読める。
- `--with-files` で `--out` なし、`--with-files --format import` は exit code 1。

- [ ] **Step 2: 落ちることを確認 → Step 3: 実装 → Step 4: PASS 確認 → Step 5: コミット**

`feat(cli): export --with-files で添付同梱 zip を出力`

---

### Task 5: knot backup と復元テスト

**Files:**
- Create: `src/cli/backup.ts`
- Modify: `src/cli/commands.ts` または main.ts からの配線（既存の分割慣例に従い、ロジックは backup.ts、usage は main.ts）
- Test: `test/cli/backup.test.ts`

**Interfaces:**
- Consumes: `openDatabase`、`node:sqlite` の `backup(sourceDb, destPath)`（Node 24 で利用可能なことを確認済み）、`SqliteStorage`、`createApp`（復元テストで使用）。
- Produces:
  - `src/cli/backup.ts`: `runBackup(dataDir: string, outDir: string): Promise<string>`。
  - CLI: `knot backup --data <dir> --out <destdir>`。

**挙動仕様（設計書 27 の順序を厳守）:**
1. パス検査: dataDir と outDir を realpath（親ディレクトリまで）解決し、同一・相互包含（outDir が dataDir 配下、dataDir が outDir 配下）なら CliError。outDir が存在して空でなければ CliError（上書きによる過去バックアップ破壊を防ぐ）。
2. 出力は outDir と同じ親ディレクトリの一時ディレクトリ（例 `.<basename>.tmp-<pid>`）へ組み立て、**全工程成功後に rename で outDir へ確定**する。失敗時は一時ディレクトリを削除して CliError（部分出力を残さず、同じコマンドをそのまま再実行できる）。
3. **先に** `dataDir/files/` を一時ディレクトリの files/ へ再帰コピー（cpSync）。`config.json` があればコピー。
4. **その後** ソース DB を openDatabase で開き、`backup()` で一時ディレクトリの knot.db へスナップショット（WAL 中でも一貫スナップショットになる。これが files 先行コピーと合わせて「DB が参照するファイルが欠けない」根拠。理由をコードコメントに残す）。
5. 完了後の検証: スナップショット DB を開き attachments 全行の id について files/<id> の存在を確認。欠けがあれば欠落 id を列挙して CliError。
6. rename して成功時 `backed up to <outDir> (N attachments verified)` を返す。
7. 稼働中サーバに対する backup は、files コピーと DB スナップショットの間に添付アップロードが割り込むと検証失敗になり得る。これは仕様（fail loudly）であり、backup の再実行で解決する。コードコメントと ops.md（Task 11 §5）に明記する。

- [ ] **Step 1: 失敗するテストを書く**

test/cli/backup.test.ts:
- **復元テスト（スペックの受け入れ条件）**: init → import fixture → 添付 1 件（DB 行 + 実ファイル）→ runBackup → バックアップ先を dataDir として SqliteStorage + createApp を組み、ログイン → `GET /api/pages/:project/:title` 200、`GET /files/:id`（既存 files ルートの実パスに合わせる）200 を確認。
- 検証の失敗系: dataDir/files から実ファイルを消してから runBackup → reject（メッセージに欠落 id）。**失敗後に outDir も一時ディレクトリも残っておらず、ファイルを戻して同じ引数で再実行すると成功する。**
- outDir 非空 → reject。outDir が dataDir 自身・dataDir 配下（例 dataDir/files/bk）・dataDir を包含する親 → いずれも reject。
- バックアップ実行後に元 DB へ書き込んでもバックアップ側が変化しない（スナップショットである）ことを 1 ケース。

- [ ] **Step 2: 落ちることを確認 → Step 3: 実装 → Step 4: PASS 確認 → Step 5: コミット**

`feat(cli): knot backup（files 先行コピー + SQLite スナップショット + 添付検証）`

---

### Task 6: 定期自動エクスポート（serve 内蔵、世代管理付き）

**Files:**
- Create: `src/server/autoExport.ts`
- Modify: `src/server/config.ts`（キー追加）
- Modify: `src/cli/commands.ts` の `runServe`（起動配線）
- Test: `test/server/auto-export.test.ts`, `test/server/config.test.ts` へ追記

**Interfaces:**
- Consumes: `buildExportZip`（Task 4）、`storage.listProjects()`。
- Produces:
  - config.json 追加キー（defaultConfig と VALIDATORS の両方）:
    - `autoExportDir: string | null`（既定 null = 無効。相対パスは dataDir 基準で解決）
    - `autoExportIntervalHours: number`（既定 24、正の整数）
    - `autoExportKeep: number`（既定 7、正の整数。プロジェクトごとの保持世代数）
  - `src/server/autoExport.ts`:
    - `runAutoExportOnce(storage: Storage, dataDir: string, opts: { dir: string; keep: number }, now: number): Promise<{ written: string[]; pruned: string[] }>`
    - `startAutoExport(deps: { storage: Storage; dataDir: string; config: ServerConfig; now?: () => number }): { stop(): void }`

**挙動仕様:**
- 保存形式は**プロジェクトごとのサブディレクトリ** `<autoExportDir>/<projectName>/<YYYYMMDD-HHMMSS>.zip`（UTC、now から生成）。ファイル名からプロジェクトを判定するパース処理は書かない（`a` と `a-b` のような prefix 衝突を構造で排除する）。出力先は mkdir -p する。
- 書き込みは同ディレクトリの一時名（例 `<name>.zip.tmp`）へ書いてから rename で確定する（途中終了による破損 zip を最終名で残さない）。同秒衝突で最終名が既に存在する場合は rename の上書きで確定してよい（同一 now からの再生成は同内容）。
- 世代管理: **各プロジェクトのサブディレクトリ内だけ**を対象に、`*.zip` を名前降順に並べ新しい方から keep 件を残して削除。`.tmp` は対象外。
- 実行ロック: プロセス内で「実行中フラグ」を持ち、前回の runAutoExportOnce が終わっていなければその周期は skip する（多重実行しない）。knot v1 は単一プロセス運用が前提であり、プロセス間ロックは実装しない（前提をコメントに明記）。
- `startAutoExport` は起動直後に 1 回実行し、以後 intervalHours ごと（`setInterval`、`unref()` してプロセス終了を妨げない）。`stop()` はタイマーを解除するだけで進行中の実行は待たない（tmp + rename により最終名の破損は起きない）。
- 1 回の実行中の失敗（プロジェクト単位の StorageError など）は console.error に記録して serve は落とさない。次周期で再試行される。
- `runServe` は `config.autoExportDir` が設定されているときだけ start する。autoExportDir は dataDir 外を推奨（ops.md に記載。`knot backup` の対象は files/ + knot.db + config.json のみで、自動エクスポート zip はバックアップに含まれない）。

- [ ] **Step 1: 失敗するテストを書く**

test/server/auto-export.test.ts:
- プロジェクト 2 つを仕込み runAutoExportOnce → 各サブディレクトリに 1 ファイル、written に 2 パス、zip が readZip で読める。`.tmp` が残っていない。
- keep=2 で now を進めながら 3 回実行 → 各プロジェクトのファイルが 2 件に刈り込まれ、pruned が最古を指す。
- prefix 衝突: プロジェクト `a` と `a-b` を両方仕込み、片方の刈り込みがもう片方のファイルに触れない。
- 同一 now で 2 回実行してもエラーにならず、ファイルは 1 件のまま。
- 添付欠落プロジェクトがあっても他プロジェクトの zip は書かれ、reject しない（エラーは握って継続）。
- `startAutoExport` は `node:test` の `mock.timers`（setInterval を mock）で、起動時 1 回 + interval 経過でもう 1 回走ることを確認し、`stop()` 後は走らないこと。

config.test.ts 追記: 新キー 3 つの既定値、型不正（負数・非整数・非文字列）が reject されること。

- [ ] **Step 2: 落ちることを確認 → Step 3: 実装 → Step 4: PASS 確認 → Step 5: コミット**

`feat(server): Cosense 互換 zip の定期自動エクスポート（autoExportDir/IntervalHours/Keep）`

---

### Task 7: 受け入れテスト 1 — scrapbox-cosense-mcp（MCP サーバ）

**Files:**
- Create: `test/fixtures/tls/localhost-cert.pem`, `test/fixtures/tls/localhost-key.pem`（テスト専用・自己署名）
- Create: `test/acceptance/mcp-server.test.ts`
- Modify: `package.json`（devDependencies: `scrapbox-cosense-mcp@^0.7.3`, `@modelcontextprotocol/sdk@^1`）

**Interfaces:**
- Consumes: `createApp` / `SqliteStorage` / seedPage、@hono/node-server の `serve({ fetch, port, hostname, createServer, serverOptions })`（node:https の createServer と key/cert を渡せることを型定義で確認済み）、MCP SDK の `Client` + `StdioClientTransport`。
- Produces: `npm test` に含まれる受け入れテスト 1 本。CI がこれを回すことで「動作保証する周辺ツール」の列挙が実行可能な形になる。

**挙動仕様:**
- TLS フィクスチャは一度だけ生成してコミットする（Step 0 参照）。テスト専用の localhost 鍵であり秘匿価値はない。
- テストの構成:
  1. in-memory SqliteStorage + createApp（secureCookie: false）を node:https で 127.0.0.1 の空きポート（port 0 → `server.address()` で実ポート取得）に起動。
  2. プロジェクト `sandbox` にページを 2〜3 件 seed（本文に検索で引っかかる一意な文字列を入れる）。ユーザーとセッションを storage 直接操作で作成し sid を得る。
  3. `StdioClientTransport` で MCP サーバを子プロセス起動。command は `process.execPath`、args は scrapbox-cosense-mcp の bin 実体（`node_modules/scrapbox-cosense-mcp/package.json` の bin フィールドを require.resolve で解決）。env: `API_DOMAIN=127.0.0.1:<port>`（サーバの bind と同じ 127.0.0.1 に統一する。`localhost` は環境により ::1 を優先して IPv4 bind に届かないため使わない。証明書に IP SAN 127.0.0.1 を含めるのはこのため）、`COSENSE_PROJECT_NAME=sandbox`、`COSENSE_SID=<sid>`、`NODE_EXTRA_CA_CERTS=test/fixtures/tls/localhost-cert.pem`（絶対パスに解決して渡す。自己署名証明書を子プロセスの信頼ストアに追加する。`NODE_TLS_REJECT_UNAUTHORIZED=0` による検証無効化はしない。openssl req -x509 の既定で CA:TRUE が付くため信頼アンカーとして機能する）。
  4. `client.callTool` で `list_pages` → 返却テキストに seed したタイトルが含まれる。`get_page {pageTitle}` → 本文行が含まれる。`search_pages {query}` → 一意文字列のページがヒットする。
  5. 後始末: client.close / server.close。テストが失敗しても子プロセスが残らないよう try/finally。

- [ ] **Step 0: TLS フィクスチャ生成（1 回だけ、コミットに含める）**

Run:
`openssl req -x509 -newkey rsa:2048 -nodes -keyout test/fixtures/tls/localhost-key.pem -out test/fixtures/tls/localhost-cert.pem -days 36500 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`
Expected: pem 2 ファイル。`openssl x509 -in ... -noout -text` で SAN を確認。

- [ ] **Step 1: devDependencies 追加**

Run: `npm install -D scrapbox-cosense-mcp@^0.7.3 @modelcontextprotocol/sdk@^1` → `direnv reload`
Expected: package-lock 更新、dev shell 再構築。

- [ ] **Step 2: 失敗するテストを書く（上記 1〜5 の構成）**

Run: `direnv exec . node --test test/acceptance/mcp-server.test.ts`
Expected: HTTPS 配線・ツール呼び出しが未実装の段階では FAIL（テスト自体の配線を先に完成させる。knot 本体のプロダクションコードはこのタスクでは変更しない想定なので、ここでの「失敗→実装」はテストコードの組み上げを指す）。

- [ ] **Step 3: テストを通す**

Run: `direnv exec . npm test`
Expected: 受け入れテスト含め全 PASS。3 ツール（list_pages / get_page / search_pages）のアサーションが「Cosense 互換」の実行可能な定義になっていること。

- [ ] **Step 4: コミット**

`test(acceptance): scrapbox-cosense-mcp を knot に向けて実行する受け入れテスト`

---

### Task 8: 受け入れテスト 2 — @helpfeel/cosense-cli（公式 CLI = エクスポート系ツール）

**Files:**
- Create: `test/acceptance/cosense-cli.test.ts`
- Modify: `package.json`（devDependencies: `@helpfeel/cosense-cli@^1.10.0`）

**Interfaces:**
- Consumes: Task 1（PAT）、Task 2（v2 / users エンドポイント）、`serve`（plain http）、`generateApiToken`。
- Produces: `npm test` に含まれる受け入れテスト 1 本。

**挙動仕様:**
- knot を **http** で 127.0.0.1 の空きポートに起動（この CLI は http origin を受け付けるので TLS 不要）。
- ユーザー作成 → `generateApiToken` + `storage.createApiToken` で PAT を仕込む。
- 起動方法は Task 7 と統一する: `require.resolve('@helpfeel/cosense-cli/package.json')` でパッケージ位置を解決し、その `bin` フィールドが指す実体ファイルを `execFile(process.execPath, [binPath, <command>, ...])` で起動する（`.bin/` の shim は OS 依存があるため使わない）。env に `COSENSE_PAT=<token>` を渡す。
- 検証コマンドと期待:
  - `listPages http://127.0.0.1:<port>/sandbox` → stdout の JSON に `count` と seed したタイトル。
  - `readPage http://127.0.0.1:<port>/sandbox/<タイトル>` → 本文行のテキスト。
  - `searchFullText` → 一意文字列でヒット（引数の並びは `--help` で確認して合わせる）。
- ネガティブ 1 件: `COSENSE_PAT` なし（または不正値）で listPages が非 0 exit + 401 を含むエラー出力。

- [ ] **Step 1: devDependency 追加**

Run: `npm install -D @helpfeel/cosense-cli@^1.10.0` → `direnv reload`

- [ ] **Step 2: 失敗するテストを書く → Step 3: 通す**

Run: `direnv exec . node --test test/acceptance/cosense-cli.test.ts` → 修正 → `direnv exec . npm test` 全 PASS。
（このテストが落ちる場合の典型は Task 2 のエンドポイント形状。CLI のエラー出力に落ちた URL が出る。**判断基準は Task 2 に固定した互換契約であり、実装者はその範囲内で knot 側を直す。契約に無いフィールド・エンドポイントの不足が判明した場合は、勝手に契約を広げずユーザーに報告して判断を仰ぐ。**）

- [ ] **Step 4: コミット**

`test(acceptance): 公式 cosense-cli（PAT 認証）を knot に向けて実行する受け入れテスト`

---

### Task 9: Docker イメージ

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `scripts/docker-smoke.sh`

**Interfaces:**
- Consumes: 既存の `npm run build:client`、`knot serve --data /data --hostname 0.0.0.0`。
- Produces: `docker build -t knot .` で動くイメージ。ボリューム `/data`、ポート 3000。

**挙動仕様:**
- 多段ビルド。build ステージ（node:24-slim）: package.json / package-lock.json / rolldown.config.ts を COPY → `npm ci` → src と public を COPY → `npm run build:client` → `npm prune --omit=dev`。
- runtime ステージ（node:24-slim）: pruned node_modules、src、public（build 成果物込み）、package.json を COPY。**`RUN mkdir -p /data && chown node:node /data` を `VOLUME /data` 宣言より前に置く**（named volume は初回マウント時にイメージ側ディレクトリの所有権を引き継ぐため、これで node ユーザーの init / 書き込みが通る。bind mount の場合はホスト側の所有権合わせが運用者の責任になる旨を ops.md に書く）。`USER node`、`VOLUME /data`、`EXPOSE 3000`、`ENTRYPOINT ["node", "src/cli/main.ts"]`、`CMD ["serve", "--data", "/data", "--port", "3000", "--hostname", "0.0.0.0"]`。
- サーバは type stripping で src をそのまま実行する（ビルドしない方針は Docker 内でも同じ）。
- init は自動化しない（serve の「init 済みでなければ落ちる」ガードを尊重）。初期化・ユーザー追加は `docker run --rm -v <vol>:/data knot init --data /data` のように CMD を差し替えて行う。手順は Task 11 の ops.md に書く。
- `.dockerignore`: `node_modules`, `data`, `test`, `test-results`, `e2e`, `docs`, `.git`, `public/build`, `*.md` など。COPY 対象が最小になること。

- [ ] **Step 1: Dockerfile と .dockerignore を書く**

- [ ] **Step 2: スモークスクリプトを書く（CI と共用の単一ソース）**

`scripts/docker-smoke.sh` を作り、Task 10 の CI job はこれをそのまま実行する（手順の二重管理をしない）。内容:
1. `docker build -t knot:smoke .`
2. `docker volume create knot-smoke-$$`（一意名）
3. `init --data /data` → `user add`（stdin でパスワード、`--name alice`）
4. `docker run -d` で serve を起動し、`/api/pages/none` が 401 を返すまでリトライ付きで待機（最大 30 秒、curl 失敗は継続）。
5. ログイン検証: `POST /api/knot/session` に `content-type: application/json` + `X-Knot-Client` ヘッダと `{"name":"alice","password":...}` を送り 200 を確認。
6. **再起動後の volume 書き込み検証**: コンテナを restart し、ログイン → `POST /api/knot/projects/smoke` が 200（named volume の所有権と永続化の確認。指摘 #1 の回帰テスト）。
7. cleanup は trap で必ず実行（`docker rm -f` + `docker volume rm`）。失敗時も残骸を残さない。

- [ ] **Step 3: 手元で実行して確認する（docker が使える環境の場合）**

Run: `bash scripts/docker-smoke.sh`
Expected: exit 0。
docker が無い環境ではこの Step をスキップし、Task 10 の CI job で検証されることを明記してコミットする。

- [ ] **Step 4: コミット**

`feat(docker): node:24-slim 多段ビルドの Docker イメージ`

---

### Task 10: CI（GitHub Actions）

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 既存 npm scripts（test / typecheck / lint / build:client / test:e2e）、Task 7・8 の受け入れテスト（npm test に含まれる）、Task 9 の Dockerfile。
- Produces: push / pull_request（main 対象）で走る 3 job の workflow。

**挙動仕様:**
- job `test`: ubuntu-latest、actions/checkout + actions/setup-node（node-version: 24, cache: npm）→ `npm ci` → `npm run typecheck` → `npm run lint` → `npm run build:client` → `npm test`。受け入れテストはここで一緒に走る（外部ネットワーク不要。ツールは npm ci で入る）。
- job `e2e`: `npm ci` → `npx playwright install --with-deps chromium` → `npm run test:e2e`。
- job `docker`: `bash scripts/docker-smoke.sh` を実行する（Task 9 で定義した単一ソース。build → init → user add → 起動待機 → 401 → ログイン 200 → 再起動後書き込み → cleanup を含む）。
- nix / direnv は CI では使わない（プレーン npm で完結することが Global Constraints の範囲で成り立つ）。

- [ ] **Step 1: workflow を書く**
- [ ] **Step 2: ローカルで各コマンド列を素の npm で再現确认**

Run: `npm ci && npm run typecheck && npm run lint && npm run build:client && npm test`（nix 外での成立確認。無理な環境なら direnv exec で代替し、その旨をコミットメッセージに書く）

- [ ] **Step 3: コミットして push、Actions の 3 job が green になることを確認**

`ci: テスト・E2E・Docker スモークの GitHub Actions を追加`

---

### Task 11: 運用ドキュメント（docs/ops.md）

**Files:**
- Create: `docs/ops.md`
- Modify: `README.md`（ops.md へのリンクを追記）

**Interfaces:**
- Consumes: 本計画の全成果物（backup / export --with-files / autoExport 設定 / token / Docker / 受け入れテスト）。
- Produces: 配布物としての運用ドキュメント。

**挙動仕様（章立てと必須内容）:**
1. **起動と設定**: `knot serve` のフラグ、config.json の全キー表（allowedImageHosts 〜 autoExportKeep。既定値と意味）。想定リソース: 通常運用でメモリ 200MB 程度。ただし export --with-files / 自動エクスポート / backup の実行中は zip をメモリ上に構築するため、対象プロジェクトの添付合計サイズぶんのピークが上乗せされる（数 GB 規模の添付を持つ運用は v1 の対象外）と明記する。
2. **ユーザーとトークン**: `knot user add`、`knot token add/list/revoke`、PAT の使い方（`x-personal-access-token` ヘッダ / 公式 cosense-cli の `COSENSE_PAT`）。
3. **リバースプロキシ設定例**: nginx と Caddy の 2 例。必須ポイントを本文で説明する — `X-Forwarded-Proto`、HTTPS 終端時に secureCookie が auto で secure になる条件（serve の hostname が loopback かどうかで決まる現実装の挙動を正確に書く）、`client_max_body_size`（アップロード上限 maxUploadBytes と揃える）、`/files/` と `/assets/` を含む全パス転送。**既知の制約として必ず書く**: ログイン試行のレートリミットは接続元 socket アドレスをキーにしており `X-Forwarded-For` を解釈しないため、プロキシ・Cloudflare Tunnel 配下では全利用者が同一キーを共有する（誰かの失敗 10 回で全員が 10 分ロックアウトされ得る。trusted proxy 対応は v2 検討事項）。
4. **Cloudflare Tunnel**: 自宅 PC + 0 円構成の設定例（cloudflared の config 断片）。
5. **バックアップと復元**: `knot backup` の手順と原理（files 先行 → DB スナップショット → 検証の順序の理由）、復元手順（バックアップディレクトリをそのまま `--data` に指定 / 置き換え）、cron 設定例。稼働中サーバへの backup は添付アップロードと競合すると検証エラーで失敗することがあり、**再実行すれば解決する**（部分出力は残らない）こと。バックアップ対象は files/ + knot.db + config.json のみで、自動エクスポート zip は含まれないこと。
6. **定期自動エクスポート**: autoExport 3 キーの設定例と、これが「DB 形式に依存しない保険」であるという位置づけ。autoExportDir は dataDir の外に置くことを推奨。zip の中身（`<project>.json` + `files/`）と Cosense へ持ち込む場合の手順（`--format import` との関係。**制約として明記**: 本文中の添付 URL は knot の相対 URL のままであり、Cosense 側へのファイル移行・URL 書き換えは自動化しない。files/ は knot への再取り込み・自己復元用である）。
7. **Docker 運用**: ボリューム作成 → init → user add → serve の一連、docker compose 例、イメージ更新手順。bind mount を使う場合はホスト側ディレクトリの所有権を node ユーザー（uid 1000）に合わせる必要があること（named volume はイメージ側の所有権を引き継ぐため不要）。
8. **互換性の約束**: 動作保証する周辺ツールの列挙 — `scrapbox-cosense-mcp@0.7.x`（get_page / list_pages / search_pages、`API_DOMAIN` と `COSENSE_SID` の設定方法）と `@helpfeel/cosense-cli@1.10.x`（listPages / readPage / searchFullText、`COSENSE_PAT`）。「フィールドの網羅は保証せず、受け入れテストが参照する範囲を保証する」という原則の明記。

- [ ] **Step 1: docs/ops.md を書く（上記 8 章。一文一行）**
- [ ] **Step 2: 記載したコマンド・設定キーを実物と突き合わせる**

チェック: config キー名は config.ts の VALIDATORS と一致、CLI usage は main.ts の USAGE と一致、プロキシ例のヘッダ・パスが実装と矛盾しない。ずれがあればドキュメントではなく突き合わせで見つかった側の正を採る。

- [ ] **Step 3: README にリンク追記 → コミット**

`docs(ops): 運用ドキュメント（プロキシ・バックアップ・Docker・互換性の約束）`

---

## Self-Review（作成時に実施済み）

- **スペック網羅**: 設計書 27（backup 手順・順序・検証、定期エクスポート）→ Task 5・6。設計書 17（`--with-files` zip）→ Task 4。設計書 16（受け入れテストによる互換定義、MCP + エクスポータ各 1）→ Task 7・8。設計書 29 のバックアップ復元テスト → Task 5 Step 1。Docker・運用ドキュメント・プロキシ例（ロードマップ 06）→ Task 9・11。CI 実行（設計書 16「CI で knot に向けて実行」）→ Task 10。
- **スペックからの逸脱（承認済み）**: PAT 認証と `/api/pages/v2`・`/api/projects/:project/users` はスペック未記載の追加。公式 CLI を受け入れテストに採用するための前提であり、2026-07-17 にユーザーが承認した。
- **型整合**: `createZip(entries): Buffer`（Task 3）を Task 4 の `buildExportZip` が使い、それを Task 6 の `runAutoExportOnce` が使う。`generateApiToken` は Task 1 定義・Task 8 消費。`listAttachments` は Task 4 で追加し Task 4・5 で消費（Task 5 はバックアップ先 DB を直接 SELECT してもよい）。
- **プレースホルダ**: コピー用コードを置かない方針（plan-04 errata）に基づき、各タスクは挙動仕様とテスト仕様で完結させた。外部ツールの引数並びなど実行時にしか確定しない 2 点（cosense-cli の searchFullText 引数、scrapbox-cosense-mcp の bin 実体パス）は「--help / package.json で確認する」手順として明示した。
- **外部レビュー反映（Codex、2026-07-17）**: 指摘 12 件中 10 件を計画へ反映 — Docker /data 所有権（mkdir + chown を VOLUME 前に）、世代管理のプロジェクト別サブディレクトリ化、自動エクスポートの tmp + rename と実行ロック、バックアップの一時ディレクトリ確定・パス包含拒否・再実行可能性、ZIP 非対応範囲の StorageError 拒否と DOS 時刻規則、CLI bin 実体の package.json 解決、互換契約の Task 2 への固定（Task 8 の循環判断を排除）、MCP テストの 127.0.0.1 統一、CI Docker スモークの単一スクリプト化（再起動後書き込み検証込み）。
  残る 2 件は実装変更せず ops.md の必須記載とした: #6 メモリ（2〜5 人規模でストリーミング zip は YAGNI。ピークメモリの条件を §1 に明記）、#10 レートリミットのプロキシ配下共有キー（trusted proxy 対応は v2 検討。制約を §3 に明記）。
