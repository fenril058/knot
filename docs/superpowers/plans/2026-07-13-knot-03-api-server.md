# knot 03: api-server 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hono サーバ（認証: scrypt / セッション / connect.sid / CSRF ヘッダ / レートリミット、Cosense 互換読み取り API、コミット API、添付アップロード、セキュリティヘッダ)を TDD で実装し、curl で登録から編集まで操作できる wiki API を納品する。

**Architecture:** `src/server/` に `createApp(deps)` ファクトリを置き、Hono の `app.request()` でサーバを立てずに E2E テストする。
読み取りは Cosense と同じパスと形状（`/api/pages/...`）、書き込みは knot 独自の `/api/knot/` 名前空間。
storage 層に認証・セッション・添付・読み取りクエリを足し、サーバは storage と core（applyOps / diffLines / rewritePageLinks）を組み合わせる薄い層にする。
plan-02 からの持ち越し（import の userId 再マップ、export users の範囲、プロジェクト displayName、409 title conflict の payload 設計）は本計画の序盤タスクと コミット API タスクで解消する。

**Tech Stack:** TypeScript（Node 24 type stripping、ビルドなし）、hono ^4 + @hono/node-server ^1（Task 0 で追加）、node:sqlite、node:crypto（scrypt / SHA-256 / randomBytes）、node:test。

**Spec:** `docs/superpowers/specs/2026-07-10-knot-design.md`（「読み取り API」「書き込み API」「認証とセキュリティ」「レンダリングと添付の安全化」「タイトルと URL の対応」「エラー処理」の各節）
**Roadmap:** `docs/superpowers/plans/2026-07-11-knot-roadmap.md`（この計画は 03。01 core と 02 storage-cli は main にマージ済み、110 テスト）

## Global Constraints

- Node.js >= 24。テスト実行は nix devshell 経由で **`direnv exec . npm test`**、型検査は `direnv exec . npx tsc --noEmit`。`npm install` は禁止（node_modules は importNpmLock の symlink）。
- 実行時依存は Task 0 で追加する `hono` / `@hono/node-server` と既存の `@progfay/scrapbox-parser@10.1.1` のみ。これ以外の依存追加は禁止。DB は node:sqlite、暗号は node:crypto。
- Task 0（依存追加）と Task 16 の spawn スモークテストの実行はネットワーク/子プロセスを使うため**コントローラ（Claude）側で直接行う**。Codex サブエージェントはサンドボックスの制約（ネットワークなし、spawn EPERM）で実行できない。
- テストランナーは node:test、アサーションは node:assert/strict。`npm test` で全テストが走ること。
- import 指定子は `.ts` 拡張子付き（type stripping の要件）。hono などパッケージの import は素の指定子でよい。
- tsconfig は `erasableSyntaxOnly: true`。enum・namespace・parameter properties は書けない。
- タイムスタンプは Unix 秒の整数。ID は ULID。`ulid()` の引数はミリ秒なので `ulid(now * 1000)` とする。セッション ID は `randomBytes(16).toString('hex')`（128 ビット）。
- node:sqlite の `get()` / `all()` は null プロトタイプのオブジェクトを返す。DB 行に直接 `assert.deepEqual` を使わない。
- API のエラー応答は `{error: string}` を基本形とし、任意で `message`、409 は `reason` と `page` を持つ（Task 10 で確定する形）。
- サーバのテストは `app.request(path, init, env)` で行い、`serve()`（listen）はしない。テストではミュータブルな時計 `clock = { t: <秒>, now: () => clock.t }` を `createApp` に注入する。
- コミットメッセージは日本語で、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` を付ける。
- 各タスクの最後に `direnv exec . npm test` と `direnv exec . npx tsc --noEmit` が両方成功していること。

## スコープ外（後続計画でやる）

- SSR の閲覧 UI・ログイン画面の HTML・レンダラの XSS 安全化（04 web-read）。本計画の「未ログインはログイン画面へリダイレクト」は HTML ルートが存在しないため常に 401 JSON。
- CodeMirror エディタ、自動保存、クライアント側リベース接続（05 editor）。core の `rebase()` は実装済みで、本計画は 409 応答（リベースの入力）を返すところまで。
- 周辺ツールの受け入れテスト CI、バックアップ/復元、Docker、定期エクスポート、プロキシ設定例のドキュメント（06 ops-compat）。
- public 公開モードとプロジェクト単位の権限。v1 のアクセス制御は「ログインの有無」だけ。
- page_visits（テロメア）の読み書き（04 が閲覧時に書く）。
- ページ一覧 API の `sort=accessed` / `sort=views` の実際の追跡。views は常に 0、accessed は updated で代用し、これらの sort 指定は updated 順にフォールバックする（既知の制限として応答形状だけ合わせる）。

## ファイル構成

| ファイル | 責務 |
| --- | --- |
| `src/server/config.ts` | `ServerConfig` 型、既定値、`data/config.json` の読み込みとマージ |
| `src/server/password.ts` | scrypt のハッシュ生成と検証（純関数） |
| `src/server/ratelimit.ts` | インメモリのスライディングウィンドウ `RateLimiter` |
| `src/server/http.ts` | JSON エラー応答、プロジェクト/ページ解決、`PageSnapshot` → JSON 整形の共通ヘルパ |
| `src/server/app.ts` | `createApp(deps)`: セキュリティヘッダ・認証・X-Knot-Client の各ミドルウェアとルート登録、session API |
| `src/server/routes/read.ts` | Cosense 互換読み取り API（一覧 / 本体 / text / icon / search / code） |
| `src/server/routes/write.ts` | `/api/knot/` 書き込み API（commits / text / rename / delete / import / export） |
| `src/server/routes/files.ts` | 添付のアップロードと配信（マジックバイト検査、Content-Disposition） |
| `src/core/links.ts`（変更） | `LinkTarget = {title, titleLc}` への拡張と `rewritePageLinks` |
| `src/storage/migrations/0002_links_target_title.sql` | links に原文タイトル列を追加 |
| `src/storage/types.ts` / `sqlite.ts`（変更） | 認証・セッション・添付・読み取りクエリ・renamePage / deletePage |
| `src/storage/import.ts`（変更） | userId 再マップとプロジェクト displayName の反映 |
| `src/storage/export.ts`（変更） | users を lines∪commits 由来に |
| `src/cli/commands.ts` / `main.ts`（変更） | `knot user add` / `knot serve` |
| `test/helpers/server.ts` | `:memory:` storage + createApp + ユーザー登録 + ログインのテストヘルパ |
| `test/server/*.test.ts` | 各タスクのテスト |

---

### Task 0: 依存追加（hono / @hono/node-server）と devshell 反映

**このタスクはコントローラ（Claude）が直接実行する。** package-lock の再生成に npm レジストリへのネットワークアクセスが要るため、Codex サブエージェントには委譲しない。

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`（`npm install --package-lock-only` が再生成）

**Interfaces:**
- Consumes: なし
- Produces: `import { Hono } from 'hono'`、`import { serve } from '@hono/node-server'`、`import { getCookie, setCookie } from 'hono/cookie'` が devshell 内で解決できること。以降の全タスクが前提にする。

- [ ] **Step 1: lock ファイルだけを更新して依存を追加する**

Run:

```bash
npm install --package-lock-only hono @hono/node-server
```

`--package-lock-only` は node_modules に触れない（node_modules は nix の symlink なので通常の `npm install` は禁止）。
package.json の dependencies に `hono` と `@hono/node-server` の caret 指定が入り、package-lock.json に解決結果が書かれることを確認する。

- [ ] **Step 2: devshell を再構築して import を検証する**

Run:

```bash
direnv exec . true   # importNpmLock が新しい lock から node_modules を作り直す
direnv exec . node -e "Promise.all([import('hono'), import('@hono/node-server')]).then(([h, s]) => console.log(typeof h.Hono, typeof s.serve))"
```

Expected: `function function`

flake の `importNpmLock.buildNodeModules` は package-lock.json を入力に取るため、lock 更新後の direnv 再評価で新しい node_modules が link される。
もし反映されない場合は `direnv reload` を試し、それでも失敗するならこのタスクで止めてユーザーに相談する（flake 側の調整が要る可能性）。

- [ ] **Step 3: 既存テストが壊れていないことを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 110 テスト PASS、型エラーなし

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): hono と @hono/node-server を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: plan-02 持ち越しの users / エクスポート / displayName 修正

plan-02 最終レビューの持ち越し 3 件を解消する:
(a) import で同名別 ID のユーザーが既存 ID に統合されたとき、lines.user_id が元 ID のまま残って dangling になる（Important 2）。
(b) export の users が行参照由来のみで、行を持たないユーザー（全行が上書きされた等）が round-trip で落ちる（Important 5）。
(c) import がプロジェクトの display_name をエクスポート元の displayName から取らない（Minor）。

**Files:**
- Modify: `src/storage/import.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/storage/types.ts`
- Modify: `src/storage/export.ts`（変更なしでも通るが users の出所コメントを更新）
- Test: `test/storage/import.test.ts`（追記）、`test/storage/export.test.ts`（追記）

**Interfaces:**
- Consumes: `Storage.upsertDisplayUser(user, now): Promise<string>`（実効 ID を返す。実装済み）
- Produces: `Storage.setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void>` を interface に追加。`importCosense` は export 内の userId を実効 ID に再マップし、`exp.displayName` があればプロジェクトに反映する。`listUsersForProject` は lines と commits の両方から参照ユーザーを集める。

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/import.test.ts` に追記（既存の import ヘルパ・fixture 構築に合わせる。以下は素の形）:

```ts
test('同名別 ID のユーザーは既存 ID に統合され、行の userId も再マップされる', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  // 既存ユーザー: name 'alice', id 'A1'
  await storage.upsertDisplayUser({ id: 'A1', name: 'alice', displayName: 'Alice' }, now);
  const data = {
    name: 'proj', displayName: 'Proj', exported: now,
    users: [{ id: 'A2', name: 'alice', displayName: 'Alice' }],
    pages: [{
      id: '0'.repeat(24), title: 'P', created: now, updated: now,
      lines: [{ id: '1'.repeat(24), text: 'P', userId: 'A2', created: now, updated: now }],
    }],
  };
  await importCosense(storage, data, { projectName: 'proj', now });
  const project = await storage.getProject('proj');
  const page = await storage.getPageByTitle(project!.id, 'p');
  assert.equal(page!.lines[0].userId, 'A1'); // 'A2' のままなら dangling
});

test('エクスポート元の displayName がプロジェクトに反映される', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const data = {
    name: 'proj', displayName: '素敵なプロジェクト', exported: now,
    pages: [{ title: 'P', lines: ['P'] }],
  };
  await importCosense(storage, data, { projectName: 'proj', now });
  const project = await storage.getProject('proj');
  assert.equal(project!.displayName, '素敵なプロジェクト');
});
```

`test/storage/export.test.ts` に追記:

```ts
test('行を持たないが commits に残るユーザーも export の users に含まれる', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  await storage.upsertDisplayUser({ id: 'U1', name: 'u1', displayName: 'U1' }, now);
  await storage.upsertDisplayUser({ id: 'U2', name: 'u2', displayName: 'U2' }, now);
  // U1 が作成、U2 が全行を更新 → lines は U2 のみ参照、commits は両方参照
  const pageId = ulid(now * 1000);
  const lineId = ulid(now * 1000);
  await storage.commit({
    projectId: project.id, pageId, commitId: ulid(now * 1000), baseVersion: 0,
    ops: [{ type: 'insert', id: lineId, after: '_head', text: 'T' }], userId: 'U1', now,
  });
  await storage.commit({
    projectId: project.id, pageId, commitId: ulid(now * 1000), baseVersion: 1,
    ops: [{ type: 'update', id: lineId, text: 'T2' }], userId: 'U2', now,
  });
  const exp = await exportCosense(storage, 'proj', 'full', now);
  const names = (exp.users ?? []).map((u) => u.name).sort();
  assert.deepEqual(names, ['u1', 'u2']);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（userId が 'A2' のまま / displayName が 'proj' のまま / users に 'u1' がいない、の 3 件。`setProjectDisplayName` が interface にないため tsc も落ちる）

- [ ] **Step 3: 実装する**

`src/storage/types.ts` の `Storage` interface に追加:

```ts
  /** インポート時にエクスポート元の displayName を反映する。 */
  setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void>;
```

`src/storage/sqlite.ts` に実装を追加:

```ts
  async setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void> {
    this.#db
      .prepare('UPDATE projects SET display_name = ?, updated = ? WHERE id = ?')
      .run(displayName, now, projectId);
  }
```

同じく `sqlite.ts` の `listUsersForProject` を lines∪commits 由来に置き換え:

```ts
  async listUsersForProject(projectId: string): Promise<DisplayUser[]> {
    const rows = this.#db
      .prepare(
        `SELECT u.id, u.name, u.display_name FROM users u
         WHERE u.id IN (
           SELECT l.user_id FROM lines l JOIN pages p ON p.id = l.page_id WHERE p.project_id = ?
           UNION
           SELECT c.user_id FROM commits c JOIN pages p ON p.id = c.page_id WHERE p.project_id = ?
         )
         ORDER BY u.name`,
      )
      .all(projectId, projectId) as { id: string; name: string; display_name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name }));
  }
```

`src/storage/import.ts` の `importCosense` で userId を再マップし displayName を反映（users ループと lines 構築を変更）:

```ts
  const project = await storage.ensureProject(options.projectName, now);
  if (exp.displayName !== undefined && exp.displayName !== '') {
    await storage.setProjectDisplayName(project.id, exp.displayName, now);
  }

  const importerId = await storage.upsertDisplayUser(
    { id: ulid(now * 1000), name: IMPORTER_USER_NAME, displayName: IMPORTER_USER_NAME },
    now,
  );
  const users = exp.users ?? [];
  // 同名の既存ユーザーに統合された場合に備え、export 内 ID → 実効 ID の対応を持つ
  const effectiveUserId = new Map<string, string>();
  for (const user of users) {
    const effective = await storage.upsertDisplayUser(
      { id: user.id, name: user.name, displayName: user.displayName ?? user.name },
      now,
    );
    effectiveUserId.set(user.id, effective);
  }
```

lines 構築の `userId` を差し替え:

```ts
      userId: line.userId !== undefined ? (effectiveUserId.get(line.userId) ?? line.userId) : importerId,
```

（users 配列に載っていない userId はそのまま保持する。Cosense の export では行の userId は users に列挙されるため、実運用では再マップで尽きる。）

`exp.displayName` の型が `CosenseExport` にない場合は `src/core/cosense.ts` の `CosenseExport` に `displayName?: string` を追加し、`parseExportFile` が string 以外を弾くことを確認する（既にあれば変更不要）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS（113 前後）、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/storage test/storage src/core/cosense.ts
git commit -m "fix(storage): plan-02 持ち越しの修正（import の userId 再マップ、export users を lines∪commits 由来に、プロジェクト displayName 反映）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: リンクの原文タイトル保持（links.target_title）

`search/titles` の `links` と rename の `rewriteLinks` は原文タイトル（表示形）を必要とするが、links テーブルは lc 形しか持たない。
`extractRefs` を `{title, titleLc}` の組を返すよう拡張し、links テーブルに `target_title` 列を追加する。

**Files:**
- Modify: `src/core/links.ts`
- Create: `src/storage/migrations/0002_links_target_title.sql`
- Modify: `src/storage/sqlite.ts`（`#updateDerived` の INSERT）
- Test: `test/core/links.test.ts`（期待値の形を更新）、`test/storage/derived.test.ts`（追記）

**Interfaces:**
- Consumes: `extractRefs(text): PageRefs`（実装済み。`linkTargets: string[]` を変更する）
- Produces: `export type LinkTarget = { title: string; titleLc: string }`、`PageRefs = { linkTargets: LinkTarget[]; image: string | null }`。同じ titleLc が複数回現れた場合は最初の原文を採用。links テーブルは `(project_id, source_page_id, target_title_lc, target_title)`。Task 8（search/titles）と Task 12（rename）が消費する。

- [ ] **Step 1: 失敗するテストを書く**

`test/core/links.test.ts` の既存アサートを新形状に更新する。文字列比較をしている箇所は `.map((t) => t.titleLc)` の比較に書き換え、原文保持のテストを 1 本追加する:

```ts
test('linkTargets は原文タイトルと lc 形の組を返す', () => {
  const refs = extractRefs('[Foo Bar] と #TagName と [foo bar]');
  assert.deepEqual(refs.linkTargets, [
    { title: 'Foo Bar', titleLc: 'foo_bar' },   // 同じ lc の再出現（[foo bar]）は最初の原文が勝つ
    { title: 'TagName', titleLc: 'tagname' },
  ]);
});
```

`test/storage/derived.test.ts` に追記:

```ts
test('links テーブルに原文タイトルが保存される', async () => {
  const { storage, db } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  const pageId = ulid(now * 1000);
  const titleId = ulid(now * 1000);
  await storage.commit({
    projectId: project.id, pageId, commitId: ulid(now * 1000), baseVersion: 0,
    ops: [
      { type: 'insert', id: titleId, after: '_head', text: 'P' },
      { type: 'insert', id: ulid(now * 1000), after: titleId, text: 'see [Foo Bar]' },
    ], userId: 'u', now,
  });
  const rows = db
    .prepare('SELECT target_title_lc, target_title FROM links WHERE source_page_id = ?')
    .all(pageId) as { target_title_lc: string; target_title: string }[];
  // DB 行は null プロトタイプなので plain object に詰め替えて比較する
  assert.deepEqual(
    rows.map((r) => ({ lc: r.target_title_lc, title: r.target_title })),
    [{ lc: 'foo_bar', title: 'Foo Bar' }],
  );
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`linkTargets` の要素が string のため deepEqual 不一致、`target_title` 列が無いため SQL エラー）

- [ ] **Step 3: 実装する**

`src/core/links.ts`:

```ts
export type LinkTarget = { title: string; titleLc: string };
export type PageRefs = { linkTargets: LinkTarget[]; image: string | null };

export function extractRefs(text: string): PageRefs {
  const targets = new Map<string, string>(); // titleLc → 原文（最初の出現が勝つ）
  let image: string | null = null;

  const add = (title: string): void => {
    const lc = titleLc(title);
    if (!targets.has(lc)) targets.set(lc, title);
  };

  const visit = (node: Node): void => {
    if (node.type === 'link' && node.pathType === 'relative') {
      add(stripLineId(node.href));
    } else if (node.type === 'hashTag') {
      add(node.href);
    } else if (node.type === 'link' && node.pathType === 'absolute') {
      if (image === null && classifyUrl(node.href) === 'image') image = node.href;
    } else if (node.type === 'icon' && node.pathType === 'relative') {
      add(node.path);
    } else if (node.type === 'image' || node.type === 'strongImage') {
      if (image === null) image = node.src;
    }
    if ('nodes' in node) for (const child of node.nodes) visit(child);
  };

  for (const block of parse(text)) {
    if (block.type === 'line') {
      for (const node of block.nodes) visit(node);
    } else if (block.type === 'table') {
      for (const row of block.cells) for (const cell of row) for (const node of cell) visit(node);
    }
  }
  return { linkTargets: [...targets].map(([lc, title]) => ({ title, titleLc: lc })), image };
}
```

`src/storage/migrations/0002_links_target_title.sql`:

```sql
ALTER TABLE links ADD COLUMN target_title TEXT NOT NULL DEFAULT '';
```

（既存行の原文は `knot reindex` で埋まる。マイグレーションローダは連番ファイルを順に適用する実装済みの仕組みに乗る。）

`src/storage/sqlite.ts` の `#updateDerived` を更新:

```ts
    const insertLink = this.#db.prepare(
      'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc, target_title) VALUES (?, ?, ?, ?)',
    );
    for (const target of refs.linkTargets) insertLink.run(projectId, pageId, target.titleLc, target.title);
```

`extractRefs` の他の呼び出し箇所（`grep -rn "linkTargets" src/ test/`）をすべて新形状に追随させる。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/core/links.ts src/storage test/core test/storage
git commit -m "feat(storage): links に原文タイトルを保存（search/titles と rename の土台）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: core: rewritePageLinks（リンク書き換えの純関数）

rename の `rewriteLinks: true` が使う「ページ本文中の `[旧タイトル]` / `#旧タイトル` / `[旧タイトル.icon]` を新タイトルに書き換える」純関数。
コードブロックとテーブルの構造を 尊重し、タイトル行（先頭行）は書き換えない。

**Files:**
- Modify: `src/core/links.ts`
- Test: `test/core/rewrite.test.ts`

**Interfaces:**
- Consumes: `@progfay/scrapbox-parser` の `parse`、`titleLc`、`stripLineId`、`LINE_ID_RE`（実装済み）
- Produces: `rewritePageLinks(lines: string[], oldTitleLc: string, newTitle: string): (string | null)[]` — 入力と同じ長さの配列。書き換えが起きた行は新テキスト、起きなかった行は null。`lines[0]` はページタイトル行として扱い常に null。Task 12（rename）が消費する。

- [ ] **Step 1: 失敗するテストを書く**

`test/core/rewrite.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePageLinks } from '../../src/core/links.ts';

test('ブラケットリンクとハッシュタグを書き換える', () => {
  const lines = ['Page', 'see [Old Title] here', 'tag #old_title end', 'no link'];
  const result = rewritePageLinks(lines, 'old_title', 'New Title');
  assert.deepEqual(result, [null, 'see [New Title] here', 'tag [New Title] end', null]);
  // #old_title → 新タイトルに空白があるためハッシュタグでは表せず [New Title] に落とす
});

test('新タイトルがハッシュタグ安全ならハッシュタグ形を保つ', () => {
  const lines = ['Page', '#OldTag'];
  assert.deepEqual(rewritePageLinks(lines, 'oldtag', 'NewTag'), [null, '#NewTag']);
});

test('行 ID フラグメント付きリンクはフラグメントを保持する', () => {
  const lineId = '0123456789abcdef01234567';
  const lines = ['Page', `[Old#${lineId}]`];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, `[New#${lineId}]`]);
});

test('アイコン記法を書き換える', () => {
  const lines = ['Page', 'by [old.icon]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, 'by [New.icon]']);
});

test('コードブロックの中は書き換えない', () => {
  const lines = ['Page', 'code:sample.js', ' const x = "[Old]";', '[Old]'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.deepEqual(result, [null, null, null, '[New]']);
});

test('テーブルのセル内リンクを書き換える', () => {
  const lines = ['Page', 'table:t', '\t[Old]\tb'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.deepEqual(result, [null, null, '\t[New]\tb']);
});

test('タイトル行（先頭行）は書き換えない', () => {
  const lines = ['[Old] を含むタイトル', 'body [Old]'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.equal(result[0], null);
  assert.equal(result[1], 'body [New]');
});

test('同一行に同じリンクが 2 回あれば両方書き換える', () => {
  const lines = ['Page', '[Old] and [Old]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '[New] and [New]']);
});

test('コード記法内の同一文字列は書き換えず、後続のリンクは書き換える', () => {
  const lines = ['Page', '`[Old]` and [Old]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '`[Old]` and [New]']);
});

test('装飾ノードの中のリンクも書き換える', () => {
  const lines = ['Page', '[* important [Old] here]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '[* important [New] here]']);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`rewritePageLinks` is not exported）

- [ ] **Step 3: 実装する**

`src/core/links.ts` に追加:

```ts
const HASHTAG_UNSAFE_RE = /[\s\[\]#`]/;

/**
 * ページ本文中の旧タイトルへのリンクを新タイトルに書き換える。
 * 返り値は lines と同じ長さで、変更のない行（タイトル行、コードブロック内を含む）は null。
 * scrapbox-parser のブロック構造で行位置を追跡する。
 * 置換はノードの出現順に cursor を進めながら位置を特定して行う。code 記法内などに
 * 同じ文字列が先行していても、AST が指すノードと別の箇所を書き換えることがない。
 */
export function rewritePageLinks(lines: string[], oldTitleLc: string, newTitle: string): (string | null)[] {
  const result: (string | null)[] = lines.map(() => null);
  const blocks = parse(lines.join('\n'), { hasTitle: true });
  const hashtagSafe = !HASHTAG_UNSAFE_RE.test(newTitle);

  // ノードの raw 全体を置き換えた文字列を返す。書き換え不要なら null。
  const rewriteNode = (node: Node): string | null => {
    if (node.type === 'link' && node.pathType === 'relative') {
      const target = stripLineId(node.href);
      if (titleLc(target) !== oldTitleLc) return null;
      const fragment = node.href.slice(target.length); // '#<行ID>' または ''
      return `[${newTitle}${fragment}]`;
    }
    if (node.type === 'hashTag') {
      if (titleLc(node.href) !== oldTitleLc) return null;
      return hashtagSafe ? `#${newTitle}` : `[${newTitle}]`;
    }
    if (node.type === 'icon' && node.pathType === 'relative') {
      if (titleLc(node.path) !== oldTitleLc) return null;
      return `[${newTitle}.icon]`;
    }
    if ('nodes' in node) {
      // 子ノードを raw 内で出現順に位置特定しながら再帰的に置換する
      return spliceChildren(node.raw, node.nodes);
    }
    return null;
  };

  // text 中で nodes を順に位置特定し、書き換え結果を継ぎ合わせる。変更がなければ null。
  const spliceChildren = (text: string, nodes: Node[]): string | null => {
    let out = '';
    let cursor = 0;
    let changed = false;
    for (const node of nodes) {
      const pos = text.indexOf(node.raw, cursor);
      if (pos === -1) continue; // 位置を特定できないノードは触らない
      const replacement = rewriteNode(node);
      out += text.slice(cursor, pos) + (replacement ?? node.raw);
      cursor = pos + node.raw.length;
      if (replacement !== null) changed = true;
    }
    out += text.slice(cursor);
    return changed ? out : null;
  };

  const rewriteAt = (index: number, nodes: Node[]): void => {
    const rewrittenLine = spliceChildren(result[index] ?? lines[index], nodes);
    if (rewrittenLine !== null) result[index] = rewrittenLine;
  };

  let index = 0;
  for (const block of blocks) {
    if (block.type === 'title') {
      index += 1; // タイトル行は書き換えない
    } else if (block.type === 'line') {
      rewriteAt(index, block.nodes);
      index += 1;
    } else if (block.type === 'codeBlock') {
      index += 1 + (block.content === '' ? 0 : block.content.split('\n').length);
    } else if (block.type === 'table') {
      block.cells.forEach((row, r) => rewriteAt(index + 1 + r, row.flat()));
      index += 1 + block.cells.length;
    }
  }
  return result;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS。特にコードブロック行数の勘定（`content` が空の場合）とテーブル行の対応がここで固定される。

- [ ] **Step 5: Commit**

```bash
git add src/core/links.ts test/core/rewrite.test.ts
git commit -m "feat(core): rename 用のリンク書き換え rewritePageLinks を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 4: storage: ユーザーとセッション

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Test: `test/storage/auth.test.ts`

**Interfaces:**
- Consumes: users / sessions テーブル（0001_init.sql で作成済み。読み書きは本タスクが初）
- Produces: `Storage` interface に以下を追加。Task 5（CLI user add）と Task 6（session API）が消費する。

```ts
export type AuthUser = {
  id: string; name: string; displayName: string;
  email: string | null; passwordHash: string | null; isAdmin: boolean; created: number;
};
export type NewUser = { id: string; name: string; displayName: string; email?: string; passwordHash: string; isAdmin: boolean };
export type AddUserResult = { kind: 'created' | 'claimed'; id: string };
export type Session = { id: string; userId: string; expires: number; created: number };

// interface Storage に追加:
  /**
   * ログインユーザーを追加する。同名ユーザーが password_hash なしで存在する場合
   * （インポートで作られた表示ユーザー）はパスワードを付与して昇格する（claimed）。
   * password_hash ありの同名ユーザーが既にいれば StorageError。
   */
  addUser(user: NewUser, now: number): Promise<AddUserResult>;
  getUserByName(name: string): Promise<AuthUser | null>;
  getUserById(id: string): Promise<AuthUser | null>;
  createSession(session: Session): Promise<void>;
  /** 期限切れ（expires <= now）のセッションは削除して null を返す。 */
  getSession(id: string, now: number): Promise<Session | null>;
  refreshSession(id: string, expires: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
```

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { StorageError } from '../../src/storage/types.ts';

const now = 1700000000;

test('addUser と getUserByName / getUserById', async () => {
  const { storage } = makeStorage();
  const result = await storage.addUser(
    { id: 'U1', name: 'alice', displayName: 'Alice', passwordHash: 'h1', isAdmin: true },
    now,
  );
  assert.deepEqual(result, { kind: 'created', id: 'U1' });
  const byName = await storage.getUserByName('alice');
  assert.equal(byName!.id, 'U1');
  assert.equal(byName!.passwordHash, 'h1');
  assert.equal(byName!.isAdmin, true);
  const byId = await storage.getUserById('U1');
  assert.equal(byId!.name, 'alice');
  assert.equal(await storage.getUserByName('nobody'), null);
});

test('パスワードなしの同名ユーザーはパスワード付与で昇格する', async () => {
  const { storage } = makeStorage();
  await storage.upsertDisplayUser({ id: 'U1', name: 'alice', displayName: 'Alice' }, now);
  const result = await storage.addUser(
    { id: 'U2', name: 'alice', displayName: 'Alice A', passwordHash: 'h1', isAdmin: false },
    now,
  );
  assert.deepEqual(result, { kind: 'claimed', id: 'U1' }); // ID は既存のまま
  const user = await storage.getUserByName('alice');
  assert.equal(user!.passwordHash, 'h1');
  assert.equal(user!.displayName, 'Alice A');
});

test('パスワードありの同名ユーザーへの addUser は StorageError', async () => {
  const { storage } = makeStorage();
  await storage.addUser({ id: 'U1', name: 'alice', displayName: 'A', passwordHash: 'h1', isAdmin: false }, now);
  await assert.rejects(
    storage.addUser({ id: 'U2', name: 'alice', displayName: 'B', passwordHash: 'h2', isAdmin: false }, now),
    StorageError,
  );
});

test('セッションの作成・取得・削除', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  const s = await storage.getSession('s1', now);
  assert.equal(s!.userId, 'U1');
  await storage.deleteSession('s1');
  assert.equal(await storage.getSession('s1', now), null);
});

test('期限切れセッションは取得時に削除されて null', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  assert.equal(await storage.getSession('s1', now + 100), null);
  // 期限を戻しても復活しない（行が消えている）
  await storage.refreshSession('s1', now + 1000);
  assert.equal(await storage.getSession('s1', now), null);
});

test('refreshSession で期限が延びる', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  await storage.refreshSession('s1', now + 5000);
  const s = await storage.getSession('s1', now + 1000);
  assert.equal(s!.expires, now + 5000);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（tsc レベルでは interface 不足、実行時は `storage.addUser is not a function`）

- [ ] **Step 3: 実装する**

`src/storage/types.ts` に上記 Interfaces 節の型とメソッド宣言を追加する。

`src/storage/sqlite.ts` に追加:

```ts
// ファイル先頭の行型定義（PageRow などと同じ場所）に追加:
type UserRow = {
  id: string; name: string; display_name: string; email: string | null;
  password_hash: string | null; is_admin: number; created: number;
};
```

```ts
  #userRowToAuthUser(r: UserRow): AuthUser {
    return {
      id: r.id, name: r.name, displayName: r.display_name, email: r.email,
      passwordHash: r.password_hash, isAdmin: r.is_admin === 1, created: r.created,
    };
  }

  async addUser(user: NewUser, now: number): Promise<AddUserResult> {
    return this.#tx(() => {
      const existing = this.#db
        .prepare('SELECT id, password_hash FROM users WHERE name = ?')
        .get(user.name) as { id: string; password_hash: string | null } | undefined;
      if (existing) {
        if (existing.password_hash !== null) {
          throw new StorageError(`user already exists: ${user.name}`);
        }
        this.#db
          .prepare('UPDATE users SET display_name = ?, email = ?, password_hash = ?, is_admin = ? WHERE id = ?')
          .run(user.displayName, user.email ?? null, user.passwordHash, user.isAdmin ? 1 : 0, existing.id);
        return { kind: 'claimed' as const, id: existing.id };
      }
      this.#db
        .prepare('INSERT INTO users (id, name, display_name, email, password_hash, is_admin, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, user.name, user.displayName, user.email ?? null, user.passwordHash, user.isAdmin ? 1 : 0, now);
      return { kind: 'created' as const, id: user.id };
    });
  }

  async getUserByName(name: string): Promise<AuthUser | null> {
    const r = this.#db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    const r = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async createSession(session: Session): Promise<void> {
    this.#db
      .prepare('INSERT INTO sessions (id, user_id, expires, created) VALUES (?, ?, ?, ?)')
      .run(session.id, session.userId, session.expires, session.created);
  }

  async getSession(id: string, now: number): Promise<Session | null> {
    const r = this.#db.prepare('SELECT id, user_id, expires, created FROM sessions WHERE id = ?').get(id) as
      | { id: string; user_id: string; expires: number; created: number } | undefined;
    if (!r) return null;
    if (r.expires <= now) {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    return { id: r.id, userId: r.user_id, expires: r.expires, created: r.created };
  }

  async refreshSession(id: string, expires: number): Promise<void> {
    this.#db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(expires, id);
  }

  async deleteSession(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/storage test/storage/auth.test.ts
git commit -m "feat(storage): ログインユーザーとセッションの CRUD を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: scrypt パスワードと CLI `knot user add`

**Files:**
- Create: `src/server/password.ts`
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/main.ts`
- Test: `test/server/password.test.ts`、`test/cli/cli.test.ts`（追記）

**Interfaces:**
- Consumes: `Storage.addUser`（Task 4）、`openDatabase` / `SqliteStorage`（実装済み）
- Produces:
  - `hashPassword(password: string): string` — 形式 `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`（N=16384, r=8, p=1、salt 16 バイト、hash 32 バイト）
  - `verifyPassword(password: string, stored: string): boolean` — `timingSafeEqual` で比較
  - `runUserAdd(dataDir: string, name: string, displayName: string | null, isAdmin: boolean, password: string): Promise<string>` — CLI 実体。Task 6 以降のテストヘルパはこれではなく `hashPassword` + `storage.addUser` を直接使う。
  - CLI: `knot user add --data <dir> --name <name> [--display-name <s>] [--admin]`（パスワードは stdin から読む）

- [ ] **Step 1: 失敗するテストを書く**

`test/server/password.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/server/password.ts';

test('ハッシュと検証が往復する', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('同じパスワードでも salt でハッシュが変わる', () => {
  assert.notEqual(hashPassword('pw12345678'), hashPassword('pw12345678'));
});

test('壊れた保存形式は false（例外にしない）', () => {
  assert.equal(verifyPassword('pw', 'not-a-hash'), false);
  assert.equal(verifyPassword('pw', 'scrypt:16384:8:1:AAAA'), false);
});

test('許可しない scrypt パラメータは検証せず false（巨大な N による DoS 防止）', () => {
  const salt = 'A'.repeat(22); // 16 バイトの base64url
  const hash = 'A'.repeat(43); // 32 バイトの base64url
  assert.equal(verifyPassword('pw', `scrypt:1048576:8:1:${salt}:${hash}`), false);
  assert.equal(verifyPassword('pw', `scrypt:16384:8:1:${'A'.repeat(4)}:${hash}`), false); // salt 長不正
});
```

`test/cli/cli.test.ts` に追記（既存の CLI テストの流儀＝`runXxx` 直呼びに合わせる）:

```ts
test('user add がユーザーを作り、同名の再実行は失敗する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-cli-'));
  await runInit(dir);
  const out = await runUserAdd(dir, 'alice', 'Alice', true, 'pw12345678');
  assert.match(out, /alice/);
  await assert.rejects(runUserAdd(dir, 'alice', null, false, 'other-pass'), /already exists/);
});

test('user add は短いパスワードと不正な名前を拒否する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-cli-'));
  await runInit(dir);
  await assert.rejects(runUserAdd(dir, 'alice', null, false, 'short'), CliError);
  await assert.rejects(runUserAdd(dir, 'Bad Name!', null, false, 'pw12345678'), CliError);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`src/server/password.ts` がない、`runUserAdd` が export されていない）

- [ ] **Step 3: 実装する**

`src/server/password.ts`:

```ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // 保存形式は hashPassword が発行する 1 種類に固定する。
  // DB 内の値をそのまま scryptSync に渡すと、巨大な N を仕込まれたときに
  // イベントループを止められる（保存値由来の DoS）ため、パラメータは検証せず照合で弾く。
  if (parts[1] !== String(N) || parts[2] !== String(R) || parts[3] !== String(P)) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length !== 16 || expected.length !== 32) return false;
  try {
    const actual = scryptSync(password, salt, expected.length, { N, r: R, p: P });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

`src/cli/commands.ts` に追加:

```ts
const USER_NAME_RE = /^[a-z0-9_-]+$/;
const MIN_PASSWORD_LENGTH = 8;

export async function runUserAdd(
  dataDir: string,
  name: string,
  displayName: string | null,
  isAdmin: boolean,
  password: string,
): Promise<string> {
  if (!USER_NAME_RE.test(name)) throw new CliError(`invalid user name: ${name} (must match ${USER_NAME_RE})`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const now = Math.floor(Date.now() / 1000);
  const storage = openStorage(dataDir); // 既存コマンドが使う「DB を開いて SqliteStorage を作る」共通処理に合わせる
  try {
    const result = await storage.addUser(
      { id: ulid(now * 1000), name, displayName: displayName ?? name, passwordHash: hashPassword(password), isAdmin },
      now,
    );
    return result.kind === 'claimed'
      ? `claimed existing user ${name} (${result.id})`
      : `created user ${name} (${result.id})`;
  } finally {
    await storage.close();
  }
}
```

（`openStorage` 相当の共通処理は既存の runImport / runExport の実装に合わせる。StorageError はそのまま伝播してよい — main.ts が message を表示する。）

`src/cli/main.ts` の USAGE とディスパッチに追加:

```
  knot user add --data <dir> --name <name> [--display-name <name>] [--admin]
                (パスワードは標準入力から読む: echo -n 'pass' | knot user add ...)
```

```ts
    case 'user': {
      if (positionals[0] !== 'add' || positionals.length !== 1 || values.name === undefined) throw new CliError(USAGE);
      const password = (await readStdin()).replace(/\n$/, '');
      return runUserAdd(data, values.name, values['display-name'] ?? null, values.admin === true, password);
    }
```

parseArgs の options に `name: { type: 'string' }`、`'display-name': { type: 'string' }`、`admin: { type: 'boolean' }` を追加し、stdin ヘルパを置く:

```ts
async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/server/password.ts src/cli test/server/password.test.ts test/cli
git commit -m "feat(cli): scrypt パスワードと knot user add を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Hono アプリ骨格（セキュリティヘッダ、認証、session API、レートリミット）

サーバの土台。以降の全ルートタスクはこの `createApp` にルートを足していく。

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/ratelimit.ts`
- Create: `src/server/http.ts`
- Create: `src/server/app.ts`
- Create: `test/helpers/server.ts`
- Test: `test/server/ratelimit.test.ts`、`test/server/session.test.ts`

**Interfaces:**
- Consumes: `Storage`（Task 4 の auth/session メソッド込み）、`hashPassword` / `verifyPassword`（Task 5）
- Produces:

```ts
// src/server/config.ts
export type ServerConfig = {
  dataDir: string;
  allowedImageHosts: string[];      // 既定 ['i.gyazo.com', 'gyazo.com']
  allowedMediaHosts: string[];      // 既定 []
  allowedFrameHosts: string[];      // 既定 []
  maxUploadBytes: number;           // 既定 10 * 1024 * 1024
  secureCookie: boolean | 'auto';   // 既定 'auto'（serve 時に loopback なら false、それ以外は true に解決。Task 16）
  sessionTtlSeconds: number;        // 既定 30 * 24 * 60 * 60
};
export function defaultConfig(dataDir: string): ServerConfig;
// <dataDir>/config.json があれば defaultConfig にマージ。
// 未知キーと型・範囲の不正は Error。読めない理由が ENOENT のときだけ既定値にフォールバック
export function loadConfig(dataDir: string): ServerConfig;

// src/server/ratelimit.ts
export class RateLimiter {
  constructor(limit: number, windowSeconds: number);
  allow(key: string, now: number): boolean; // 許可なら true（消費する）
}

// src/server/http.ts
export type ApiEnv = { Variables: { userId: string } };
export function jsonError(c: Context, status: number, error: string, extra?: Record<string, unknown>): Response;
export function pageToJson(page: PageSnapshot): {
  id: string; title: string; version: number; created: number; updated: number;
  lines: { id: string; text: string; userId: string; created: number; updated: number }[];
};
export function clientIp(c: Context): string; // node-server の socket から。無ければ 'local'

// src/server/app.ts
export type AppDeps = { storage: Storage; config: ServerConfig; now?: () => number };
export function createApp(deps: AppDeps): Hono<ApiEnv>;

// test/helpers/server.ts
export type TestServer = {
  app: Hono; storage: Storage; clock: { t: number; now: () => number };
  /** hashPassword + addUser でユーザーを作る */
  addUser(name: string, password: string, isAdmin?: boolean): Promise<string>; // userId を返す
  /** ログインして 'connect.sid=...' の Cookie ヘッダ値を返す */
  login(name: string, password: string): Promise<string>;
  /** Cookie と X-Knot-Client を付けた app.request */
  request(path: string, init?: RequestInit, cookie?: string): Promise<Response>;
};
export async function makeServer(): Promise<TestServer>;
```

挙動の確定事項:
- 全ルートで認証必須。例外は `POST /api/knot/session`（ログイン）のみ。未認証は 401 `{error: 'unauthorized'}`。
- 認証はクッキー `connect.sid` のセッション ID。ログイン成功時に `HttpOnly; SameSite=Lax; Path=/`（`secureCookie !== false` なら `Secure`。`'auto'` の実解決は Task 16 の serve 起動時）、`Max-Age = sessionTtlSeconds` で発行。
- スライディング延長: 認証済みリクエストで `expires - now < sessionTtlSeconds - 86400`（前回延長から 1 日超）なら `refreshSession(id, now + ttl)` してクッキーを再発行。
- `/api/knot/` 配下の POST / PUT / DELETE はヘッダ `X-Knot-Client` 必須（値は任意の非空文字列）。欠落は 403 `{error: 'forbidden', message: 'X-Knot-Client header required'}`。ログイン・ログアウトも対象。
- ログインのレートリミット: キー `${clientIp}:${name}`、10 回 / 10 分。超過は 429 `{error: 'too_many_attempts'}`。成功・失敗を問わず試行で消費する。
- 全応答にセキュリティヘッダ: `X-Content-Type-Options: nosniff` と `Content-Security-Policy: default-src 'self'; img-src 'self' <allowedImageHosts...>; media-src 'self' <allowedMediaHosts...>; frame-src <allowedFrameHosts... または 'none'>`。
- `POST /api/knot/session` body `{name, password}` → 200 `{id, name, displayName, isAdmin}` + Set-Cookie。認証失敗は 401 `{error: 'invalid_credentials'}`（ユーザー不在とパスワード不一致を区別しない）。
- `DELETE /api/knot/session` → セッション削除、`Max-Age=0` でクッキー破棄、200 `{ok: true}`。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/ratelimit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/server/ratelimit.ts';

test('limit 回までは許可、超過は拒否、窓が過ぎればまた許可', () => {
  const rl = new RateLimiter(3, 600);
  assert.equal(rl.allow('k', 1000), true);
  assert.equal(rl.allow('k', 1001), true);
  assert.equal(rl.allow('k', 1002), true);
  assert.equal(rl.allow('k', 1003), false);
  assert.equal(rl.allow('other', 1003), true); // キーは独立
  assert.equal(rl.allow('k', 1000 + 601), true); // 最初の記録が窓から外れる
});
```

`test/helpers/server.ts`（テストヘルパ。実装は Step 3 で）と `test/server/session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('未認証の API は 401', async () => {
  const { app } = await makeServer();
  const res = await app.request('/api/pages/proj');
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('ログイン → 認証付きアクセス → ログアウト', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  assert.match(cookie, /^connect\.sid=[0-9a-f]{32}$/);
  const res = await s.request('/api/pages/none', {}, cookie);
  assert.equal(res.status, 404); // 401 ではなく「プロジェクトなし」まで到達する
  const out = await s.request('/api/knot/session', { method: 'DELETE' }, cookie);
  assert.equal(out.status, 200);
  const after = await s.request('/api/pages/none', {}, cookie);
  assert.equal(after.status, 401);
});

test('ログイン失敗は 401 invalid_credentials', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const res = await s.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
});

test('X-Knot-Client なしの書き込みは 403（ログイン自体も対象）', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const res = await s.app.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // X-Knot-Client なし
    body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
  });
  assert.equal(res.status, 403);
});

test('ログイン試行はレートリミットされる（11 回目で 429）', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  for (let i = 0; i < 10; i++) {
    const res = await s.request('/api/knot/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice', password: 'wrong' }),
    });
    assert.equal(res.status, 401);
  }
  const res = await s.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
  });
  assert.equal(res.status, 429);
});

test('セキュリティヘッダが全応答に付く', async () => {
  const s = await makeServer();
  const res = await s.app.request('/api/pages/proj');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const csp = res.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src 'self' i\.gyazo\.com gyazo\.com/);
  assert.match(csp, /frame-src 'none'/);
});

test('期限が近いセッションはアクセスで延長される（スライディング）', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  s.clock.t += 2 * 24 * 60 * 60; // 2 日経過（延長条件: 1 日超）
  const res = await s.request('/api/pages/none', {}, cookie);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('set-cookie') ?? '', /connect\.sid=/); // 再発行された
  // さらに 29 日後（当初の期限は過ぎている）でもアクセスできる
  s.clock.t += 29 * 24 * 60 * 60;
  const later = await s.request('/api/pages/none', {}, cookie);
  assert.equal(later.status, 404);
});
```

注: `/api/pages/:project` ルートは Task 7 で実装するため、このタスク時点では「未定義ルートに認証だけ通る」ことを検証できるダミーが要る。
`createApp` に本タスクで `GET /api/pages/:project` の**プロジェクト解決と 404 だけ**先行実装する（Task 7 がページ一覧応答に拡張する）。

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`src/server/app.ts` ほかが存在しない）

- [ ] **Step 3: 実装する**

`src/server/config.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ServerConfig = {
  dataDir: string;
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
  allowedFrameHosts: string[];
  maxUploadBytes: number;
  secureCookie: boolean | 'auto';
  sessionTtlSeconds: number;
};

export function defaultConfig(dataDir: string): ServerConfig {
  return {
    dataDir,
    allowedImageHosts: ['i.gyazo.com', 'gyazo.com'],
    allowedMediaHosts: [],
    allowedFrameHosts: [],
    maxUploadBytes: 10 * 1024 * 1024,
    secureCookie: 'auto',
    sessionTtlSeconds: 30 * 24 * 60 * 60,
  };
}

function isHostArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((h) => typeof h === 'string' && /^[a-z0-9*][a-z0-9.:*-]*$/i.test(h));
}

// セキュリティ設定を型検査なしで上書きさせない（負のサイズ、文字列の secureCookie 等を拒否）
const VALIDATORS: Record<string, (v: unknown) => boolean> = {
  allowedImageHosts: isHostArray,
  allowedMediaHosts: isHostArray,
  allowedFrameHosts: isHostArray,
  maxUploadBytes: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  secureCookie: (v) => typeof v === 'boolean' || v === 'auto',
  sessionTtlSeconds: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
};

export function loadConfig(dataDir: string): ServerConfig {
  const config = defaultConfig(dataDir);
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, 'config.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return config;
    throw e; // 権限エラーやディレクトリ指定を黙って既定値にしない
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    const validate = VALIDATORS[key];
    if (!validate) throw new Error(`unknown config key: ${key}`);
    if (!validate(value)) throw new Error(`invalid config value for ${key}`);
    (config as unknown as Record<string, unknown>)[key] = value;
  }
  return config;
}
```

`src/server/ratelimit.ts`:

```ts
export class RateLimiter {
  #limit: number;
  #windowSeconds: number;
  #hits = new Map<string, number[]>();

  constructor(limit: number, windowSeconds: number) {
    this.#limit = limit;
    this.#windowSeconds = windowSeconds;
  }

  allow(key: string, now: number): boolean {
    const cutoff = now - this.#windowSeconds;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }
}
```

`src/server/http.ts`:

```ts
import type { Context } from 'hono';
import type { PageSnapshot } from '../storage/types.ts';

export type ApiEnv = { Variables: { userId: string } };

export function jsonError(c: Context, status: number, error: string, extra?: Record<string, unknown>): Response {
  return c.json({ error, ...extra }, status as 400);
}

export function pageToJson(page: PageSnapshot) {
  return {
    id: page.id,
    title: page.title,
    version: page.version,
    created: page.created,
    updated: page.updated,
    lines: page.lines.map((l) => ({ id: l.id, text: l.text, userId: l.userId, created: l.created, updated: l.updated })),
  };
}

// @hono/node-server は fetch ハンドラの env として { incoming, outgoing } を渡すため、
// 実サーバでは incoming.socket.remoteAddress が取れる。app.request のテストでは env を
// 明示的に渡すか、渡さず 'local' に落とす。取得できない環境ではレートリミットのキーが
// 全クライアント共有になる（クローズド wiki の v1 では許容し、リバースプロキシ配下の
// 実 IP 解決は運用ドキュメントと合わせて plan-06 で扱う）。
export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}
```

（`c.json(..., status)` の第 2 引数の型が literal union で合わない場合の `as 400` は Hono のバージョン次第で不要。素直に通る書き方を優先する。）

`src/server/app.ts`:

```ts
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import type { Storage } from '../storage/types.ts';
import type { ServerConfig } from './config.ts';
import { verifyPassword } from './password.ts';
import { RateLimiter } from './ratelimit.ts';
import { clientIp, jsonError, type ApiEnv } from './http.ts';

export type AppDeps = { storage: Storage; config: ServerConfig; now?: () => number };

const SESSION_COOKIE = 'connect.sid';
const REFRESH_MARGIN_SECONDS = 24 * 60 * 60;

function cspValue(config: ServerConfig): string {
  const hosts = (list: string[]): string => (list.length === 0 ? '' : ` ${list.join(' ')}`);
  const frame = config.allowedFrameHosts.length === 0 ? "'none'" : config.allowedFrameHosts.join(' ');
  return [
    "default-src 'self'",
    `img-src 'self'${hosts(config.allowedImageHosts)}`,
    `media-src 'self'${hosts(config.allowedMediaHosts)}`,
    `frame-src ${frame}`,
  ].join('; ');
}

export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const loginLimiter = new RateLimiter(10, 10 * 60);
  const csp = cspValue(config);
  const app = new Hono<ApiEnv>();

  const setSessionCookie = (c: Parameters<Parameters<typeof app.use>[1]>[0], id: string): void => {
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.secureCookie !== false, // 'auto' は serve が解決済み。未解決なら安全側（Secure）
      path: '/',
      maxAge: config.sessionTtlSeconds,
    });
  };

  // セキュリティヘッダ（全応答）
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', csp);
  });

  // X-Knot-Client（/api/knot の変更系。CSRF 遮断。ログインも対象）
  app.use('/api/knot/*', async (c, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(c.req.method) && !c.req.header('X-Knot-Client')) {
      return jsonError(c, 403, 'forbidden', { message: 'X-Knot-Client header required' });
    }
    return next();
  });

  // 認証（ログイン以外の全ルート）
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/knot/session') return next();
    const sid = getCookie(c, SESSION_COOKIE);
    const session = sid === undefined ? null : await storage.getSession(sid, now());
    if (session === null) return jsonError(c, 401, 'unauthorized');
    if (session.expires - now() < config.sessionTtlSeconds - REFRESH_MARGIN_SECONDS) {
      await storage.refreshSession(session.id, now() + config.sessionTtlSeconds);
      setSessionCookie(c, session.id);
    }
    c.set('userId', session.userId);
    return next();
  });

  app.post('/api/knot/session', async (c) => {
    let body: { name?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    }
    if (typeof body.name !== 'string' || typeof body.password !== 'string') {
      return jsonError(c, 400, 'bad_request', { message: 'name and password required' });
    }
    if (!loginLimiter.allow(`${clientIp(c)}:${body.name}`, now())) {
      return jsonError(c, 429, 'too_many_attempts');
    }
    const user = await storage.getUserByName(body.name);
    if (!user || user.passwordHash === null || !verifyPassword(body.password, user.passwordHash)) {
      return jsonError(c, 401, 'invalid_credentials');
    }
    const session = {
      id: randomBytes(16).toString('hex'),
      userId: user.id,
      expires: now() + config.sessionTtlSeconds,
      created: now(),
    };
    await storage.createSession(session);
    setSessionCookie(c, session.id);
    return c.json({ id: user.id, name: user.name, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.delete('/api/knot/session', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid !== undefined) await storage.deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // Task 7 がページ一覧応答に拡張する（本タスクはプロジェクト解決の 404 まで）
  app.get('/api/pages/:project', async (c) => {
    const project = await storage.getProject(c.req.param('project'));
    if (!project) return jsonError(c, 404, 'not_found');
    return c.json({ projectName: project.name });
  });

  return app;
}
```

（`setSessionCookie` の Context 型付けが煩雑なら `Context<ApiEnv>` を直接 import して使う。）

`test/helpers/server.ts`:

```ts
import { Hono } from 'hono';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import type { Storage } from '../../src/storage/types.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/password.ts';
import { ulid } from '../../src/core/id.ts';

export type TestServer = {
  app: Hono;
  storage: Storage;
  clock: { t: number; now: () => number };
  addUser(name: string, password: string, isAdmin?: boolean): Promise<string>;
  login(name: string, password: string): Promise<string>;
  request(path: string, init?: RequestInit, cookie?: string): Promise<Response>;
};

export async function makeServer(): Promise<TestServer> {
  const storage: Storage = new SqliteStorage(openDatabase(':memory:'));
  const clock = { t: 1_700_000_000, now: (): number => clock.t };
  const config = { ...defaultConfig('/nonexistent'), secureCookie: false };
  const app = createApp({ storage, config, now: clock.now });

  const addUser = async (name: string, password: string, isAdmin = false): Promise<string> => {
    const result = await storage.addUser(
      { id: ulid(clock.t * 1000), name, displayName: name, passwordHash: hashPassword(password), isAdmin },
      clock.t,
    );
    return result.id;
  };

  const request = (path: string, init: RequestInit = {}, cookie?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('X-Knot-Client', 'test');
    if (cookie !== undefined) headers.set('Cookie', cookie);
    return app.request(path, { ...init, headers });
  };

  const login = async (name: string, password: string): Promise<string> => {
    const res = await request('/api/knot/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
    const setCookie = res.headers.get('set-cookie')!;
    return setCookie.split(';')[0]; // 'connect.sid=<id>'
  };

  return { app, storage, clock, addUser, login, request };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/server test/server test/helpers/server.ts
git commit -m "feat(server): Hono アプリ骨格（認証・セッション API・レートリミット・セキュリティヘッダ）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 7: 読み取り API (1): ページ一覧 / text / icon

Cosense 互換の `GET /api/pages/:project`（skip / limit / sort）、`GET /api/pages/:project/:title/text`、`GET /api/pages/:project/:title/icon`。
一覧に必要な descriptions（本文先頭の非空 5 行）と linked（被リンク数）を storage のクエリとして実装する。

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Create: `src/server/routes/read.ts`
- Modify: `src/server/app.ts`（Task 6 の仮 `/api/pages/:project` を read.ts の登録に置き換え）
- Modify: `src/server/http.ts`（プロジェクト/ページ解決ヘルパ）
- Create: `test/helpers/pages.ts`（ページ構築ヘルパ。Task 8 以降のテストも使う）
- Test: `test/storage/pages-api.test.ts`、`test/server/read-list.test.ts`

**Interfaces:**
- Consumes: `decodeTitleSegment` / `titleLc`（core、実装済み）、Task 6 の `createApp` / `jsonError` / テストヘルパ
- Produces:

```ts
// storage
export type PageSummary = PageMeta & { descriptions: string[]; linked: number };
export type PageSort = 'updated' | 'created' | 'linked' | 'title';
export type ListPageSummariesOptions = { skip: number; limit: number; sort: PageSort };
// interface Storage に追加:
  listPageSummaries(projectId: string, opts: ListPageSummariesOptions): Promise<{ count: number; pages: PageSummary[] }>;

// src/server/routes/read.ts
export function registerReadRoutes(app: Hono<ApiEnv>, deps: AppDeps): void;

// src/server/http.ts に追加
/** :project を解決。無ければ jsonError 404 を投げ分けるため null を返す */
export async function resolveProject(storage: Storage, c: Context): Promise<Project | null>;
/** 不正な percent-encoding は null（URIError を 500 にしない） */
export function safeDecode(segment: string): string | null;
/** :title を safeDecode → titleLc で解決。復号できない・不在は null（呼び出し側で 404） */
export async function resolvePage(storage: Storage, projectId: string, c: Context): Promise<PageSnapshot | null>;
```

応答形状（Cosense 互換のサブセット + knot 拡張の `version`）:

```
GET /api/pages/:project?skip=0&limit=100&sort=updated
200 {
  projectName, skip, limit, count,
  pages: [{ id, title, image, descriptions, pin, views: 0, linked, created, updated, accessed }]
}
```

- `skip` 既定 0、`limit` 既定 100・上限 1000、数値でない場合は 400。
- `sort` は updated（既定）/ created / linked / title。`accessed` / `views` は追跡していないため updated にフォールバックし、その他の未知値は 400。
- `pin` は pages.pinned の値、`views` は常に 0、`accessed` は updated の別名（スコープ外節に記載の既知の制限）。
- text は `lines.map(text).join('\n')` を `text/plain; charset=utf-8` で返す。icon は `pages.image` があれば 302 リダイレクト、なければ 404。

- [ ] **Step 1: storage の失敗するテストを書く**

`test/helpers/pages.ts`（ページ構築ヘルパ。Task 8 以降のテストも import する）:

```ts
import { ulid } from '../../src/core/id.ts';
import type { Storage } from '../../src/storage/types.ts';

/** タイトル + 本文行の新規ページを 1 コミットで作り pageId を返す */
export async function seedPage(
  storage: Storage,
  projectId: string,
  title: string,
  body: string[],
  at: number,
): Promise<string> {
  const pageId = ulid(at * 1000);
  let after = '_head';
  const ops = [title, ...body].map((text) => {
    const id = ulid(at * 1000);
    const op = { type: 'insert' as const, id, after, text };
    after = id;
    return op;
  });
  await storage.commit({ projectId, pageId, commitId: ulid(at * 1000), baseVersion: 0, ops, userId: 'u', now: at });
  return pageId;
}
```

`test/storage/pages-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { ulid } from '../../src/core/id.ts';

const now = 1700000000;

test('listPageSummaries: descriptions は非空の先頭 5 行、linked は被リンク数', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Target', ['', 'one', 'two', '', 'three', 'four', 'five', 'six'], now);
  await seedPage(storage, project.id, 'Src1', ['links to [Target]'], now + 1);
  await seedPage(storage, project.id, 'Src2', ['also [Target]'], now + 2);
  const { count, pages } = await storage.listPageSummaries(project.id, { skip: 0, limit: 100, sort: 'updated' });
  assert.equal(count, 3);
  const target = pages.find((p) => p.title === 'Target')!;
  assert.deepEqual(target.descriptions, ['one', 'two', 'three', 'four', 'five']);
  assert.equal(target.linked, 2);
  assert.equal(pages.find((p) => p.title === 'Src1')!.linked, 0);
});

test('listPageSummaries: sort と skip/limit', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'B', ['[A]'], now + 1);
  await seedPage(storage, project.id, 'A', [''], now + 2);
  await seedPage(storage, project.id, 'C', ['[A]'], now + 3);
  const updated = await storage.listPageSummaries(project.id, { skip: 0, limit: 100, sort: 'updated' });
  assert.deepEqual(updated.pages.map((p) => p.title), ['C', 'A', 'B']);
  const title = await storage.listPageSummaries(project.id, { skip: 0, limit: 100, sort: 'title' });
  assert.deepEqual(title.pages.map((p) => p.title), ['A', 'B', 'C']);
  const linked = await storage.listPageSummaries(project.id, { skip: 0, limit: 100, sort: 'linked' });
  assert.equal(linked.pages[0].title, 'A'); // 被リンク 2
  const paged = await storage.listPageSummaries(project.id, { skip: 1, limit: 1, sort: 'title' });
  assert.equal(paged.count, 3); // count は全件数
  assert.deepEqual(paged.pages.map((p) => p.title), ['B']);
});

test('listPageSummaries: 削除済みページは数えず返さない', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Gone', [], now);
  const page = await storage.getPageById(pageId);
  await storage.commit({
    projectId: project.id, pageId, commitId: ulid(now * 1000), baseVersion: page!.version,
    ops: page!.lines.map((l) => ({ type: 'delete' as const, id: l.id })), userId: 'u', now,
  });
  const { count, pages } = await storage.listPageSummaries(project.id, { skip: 0, limit: 10, sort: 'updated' });
  assert.equal(count, 0);
  assert.deepEqual(pages, []);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`listPageSummaries` が存在しない）

- [ ] **Step 3: storage を実装する**

`src/storage/types.ts` に Interfaces 節の型とメソッド宣言を追加。

`src/storage/sqlite.ts` に追加:

```ts
  async listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }> {
    const orderBy: Record<PageSort, string> = {
      updated: 'p.updated DESC, p.id',
      created: 'p.created DESC, p.id',
      linked: 'linked DESC, p.updated DESC, p.id',
      title: 'p.title_lc ASC',
    };
    const count = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ? AND deleted = 0').get(projectId) as { n: number }
    ).n;
    const rows = this.#db
      .prepare(
        `SELECT p.*, (
           SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
         ) AS linked
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${orderBy[opts.sort]}
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, opts.limit, opts.skip) as (PageRow & { linked: number })[];
    const descriptions = this.#db.prepare(
      "SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5",
    );
    const pages = rows.map((r) => ({
      ...this.#pageRowToMeta(r),
      linked: r.linked,
      descriptions: (descriptions.all(r.id) as { text: string }[]).map((d) => d.text),
    }));
    return { count, pages };
  }
```

（`orderBy` は sort 値の whitelist マップであり、SQL への文字列連結はこのマップ経由のみ。）

- [ ] **Step 4: ルートの失敗するテストを書く**

`test/server/read-list.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { ulid } from '../../src/core/id.ts';

async function seedProject(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const mk = async (title: string, body: string[]): Promise<void> => {
    let after = '_head';
    const ops = [title, ...body].map((text) => {
      const id = ulid(s.clock.t * 1000);
      const op = { type: 'insert' as const, id, after, text };
      after = id;
      return op;
    });
    await s.storage.commit({
      projectId: project.id, pageId: ulid(s.clock.t * 1000), commitId: ulid(s.clock.t * 1000),
      baseVersion: 0, ops, userId: 'u', now: s.clock.t,
    });
    s.clock.t += 1;
  };
  await mk('Alpha', ['first line', 'https://i.gyazo.com/abc.png']);
  await mk('Beta', ['see [Alpha]']);
  return project.id;
}

test('GET /api/pages/:project が Cosense 形状で返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await seedProject(s);
  const res = await s.request('/api/pages/proj', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projectName, 'proj');
  assert.equal(body.skip, 0);
  assert.equal(body.limit, 100);
  assert.equal(body.count, 2);
  assert.deepEqual(body.pages.map((p: { title: string }) => p.title), ['Beta', 'Alpha']); // updated 降順
  const alpha = body.pages[1];
  assert.equal(alpha.image, 'https://i.gyazo.com/abc.png');
  assert.deepEqual(alpha.descriptions, ['first line', 'https://i.gyazo.com/abc.png']);
  assert.equal(alpha.views, 0);
  assert.equal(alpha.linked, 1);
  assert.equal(alpha.accessed, alpha.updated);
});

test('skip / limit / sort パラメータ', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await seedProject(s);
  const res = await s.request('/api/pages/proj?skip=1&limit=1&sort=title', {}, cookie);
  const body = await res.json();
  assert.equal(body.skip, 1);
  assert.equal(body.limit, 1);
  assert.deepEqual(body.pages.map((p: { title: string }) => p.title), ['Beta']);
  // 未追跡 sort は updated にフォールバック
  assert.equal((await s.request('/api/pages/proj?sort=accessed', {}, cookie)).status, 200);
  // 不正値は 400
  assert.equal((await s.request('/api/pages/proj?skip=abc', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj?sort=bogus', {}, cookie)).status, 400);
});

test('text と icon', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await seedProject(s);
  const text = await s.request('/api/pages/proj/Alpha/text', {}, cookie);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-type')!, /^text\/plain/);
  assert.equal(await text.text(), 'Alpha\nfirst line\nhttps://i.gyazo.com/abc.png');
  const icon = await s.request('/api/pages/proj/Alpha/icon', { redirect: 'manual' }, cookie);
  assert.equal(icon.status, 302);
  assert.equal(icon.headers.get('location'), 'https://i.gyazo.com/abc.png');
  assert.equal((await s.request('/api/pages/proj/Beta/icon', { redirect: 'manual' }, cookie)).status, 404);
  assert.equal((await s.request('/api/pages/proj/None/text', {}, cookie)).status, 404);
});

test('タイトルの percent-encoding が解決される', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const id = ulid(s.clock.t * 1000);
  await s.storage.commit({
    projectId: project.id, pageId: ulid(s.clock.t * 1000), commitId: ulid(s.clock.t * 1000), baseVersion: 0,
    ops: [{ type: 'insert', id, after: '_head', text: 'A/B?C' }], userId: 'u', now: s.clock.t,
  });
  const res = await s.request(`/api/pages/proj/${encodeURIComponent('A/B?C')}/text`, {}, cookie);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'A/B?C');
  // 不正な percent-encoding は 500 にせず 404
  assert.equal((await s.request('/api/pages/proj/%E0%A4%A/text', {}, cookie)).status, 404);
});
```

- [ ] **Step 5: 失敗を確認して、ルートを実装する**

Run: `direnv exec . npm test` → FAIL を確認。

`src/server/http.ts` に追加:

```ts
import { titleLc } from '../core/title.ts';
import type { PageSnapshot, Project, Storage } from '../storage/types.ts';

export async function resolveProject(storage: Storage, c: Context): Promise<Project | null> {
  return storage.getProject(c.req.param('project'));
}

/** 不正な percent-encoding（例: '%E0%A4%A'）で URIError を 500 にしない */
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function resolvePage(storage: Storage, projectId: string, c: Context): Promise<PageSnapshot | null> {
  const title = safeDecode(c.req.param('title'));
  if (title === null) return null; // 復号できない URL は不在扱い（404）
  return storage.getPageByTitle(projectId, titleLc(title));
}
```

`src/server/routes/read.ts`:

```ts
import type { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { jsonError, resolvePage, resolveProject, type ApiEnv } from '../http.ts';
import type { PageSummary, PageSort } from '../../storage/types.ts';

const SORTS = new Set<string>(['updated', 'created', 'linked', 'title']);
const FALLBACK_SORTS = new Set<string>(['accessed', 'views']); // 未追跡。updated で代用

function summaryToJson(p: PageSummary) {
  return {
    id: p.id,
    title: p.title,
    image: p.image,
    descriptions: p.descriptions,
    pin: p.pinned,
    views: 0,
    linked: p.linked,
    created: p.created,
    updated: p.updated,
    accessed: p.updated,
  };
}

export function registerReadRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;

  app.get('/api/pages/:project', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const skip = Number(c.req.query('skip') ?? '0');
    const limitRaw = Number(c.req.query('limit') ?? '100');
    const sortRaw = c.req.query('sort') ?? 'updated';
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limitRaw) || limitRaw < 1) {
      return jsonError(c, 400, 'bad_request', { message: 'invalid skip/limit' });
    }
    if (!SORTS.has(sortRaw) && !FALLBACK_SORTS.has(sortRaw)) {
      return jsonError(c, 400, 'bad_request', { message: `invalid sort: ${sortRaw}` });
    }
    const sort = (SORTS.has(sortRaw) ? sortRaw : 'updated') as PageSort;
    const limit = Math.min(limitRaw, 1000);
    const { count, pages } = await storage.listPageSummaries(project.id, { skip, limit, sort });
    return c.json({ projectName: project.name, skip, limit, count, pages: pages.map(summaryToJson) });
  });

  app.get('/api/pages/:project/:title/text', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    return c.text(page.lines.map((l) => l.text).join('\n'));
  });

  app.get('/api/pages/:project/:title/icon', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page || page.image === null) return jsonError(c, 404, 'not_found');
    return c.redirect(page.image, 302);
  });
}
```

`src/server/app.ts`: Task 6 で置いた仮の `app.get('/api/pages/:project', ...)` を削除し、session ルートの後に `registerReadRoutes(app, deps)` を呼ぶ。
`AppDeps` を read.ts から import できるよう `export type AppDeps` は app.ts に置いたままにする（循環 import にならない: read.ts は型 import のみ）。

- [ ] **Step 6: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 7: Commit**

```bash
git add src/storage src/server test/helpers/pages.ts test/storage/pages-api.test.ts test/server/read-list.test.ts
git commit -m "feat(server): Cosense 互換のページ一覧・text・icon API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 読み取り API (2): ページ本体と relatedPages / search/titles

`GET /api/pages/:project/:title`（lines / links / relatedPages）と `GET /api/pages/:project/search/titles`（リンクグラフ）。
relatedPages の 1-hop / 2-hop / 逆リンク有無を links テーブルから計算する storage クエリを実装する。

**注意: Hono のルート登録順。** `search/titles` と `search/query`（Task 9）は `/:title` より先に登録しないと `:title = 'search'` に飲まれる恐れがある。read.ts では search 系 → `/:title/...` 系 → `/:title` の順に登録する。

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/server/routes/read.ts`
- Test: `test/storage/related.test.ts`、`test/server/read-page.test.ts`

**Interfaces:**
- Consumes: links テーブル（target_title 込み、Task 2）、`resolvePage`（Task 7）
- Produces:

```ts
// storage
export type RelatedPage = {
  id: string; title: string; titleLc: string; image: string | null;
  descriptions: string[]; linksLc: string[]; linked: number; updated: number;
};
/** linked は対象ページ自身の被リンク数（ページ本体応答の linked フィールド用） */
export type RelatedPages = { links1hop: RelatedPage[]; links2hop: RelatedPage[]; hasBackLinks: boolean; linked: number };
export type TitleEntry = { id: string; title: string; hasIcon: boolean; updated: number; links: string[] };
// interface Storage に追加:
  /**
   * links1hop: このページの前方リンク先として存在するページ ∪ このページへ張っているページ。
   * links2hop: このページの前方リンク先（赤リンク含む）へ張っている他のページ（自分と 1hop を除く）。
   *            その entry の linksLc は共有しているリンク先の lc。
   * 1hop の linksLc はそのページ自身の前方リンク lc。
   * hasBackLinks: extractRefs は [X.icon] もリンクとして links に記録するため、
   * これは「逆リンクまたはアイコン参照の有無」に一致し、応答フィールド
   * hasBackLinksOrIcons の意味をそのまま満たす。
   */
  getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages>;
  /** 全ページのタイトルと前方リンク（原文タイトル）。search/titles と 2-hop・補完のデータ源 */
  listPageTitles(projectId: string): Promise<TitleEntry[]>;
```

応答形状:

```
GET /api/pages/:project/:title
200 {
  id, title, image, descriptions, pin, views: 0, linked, created, updated, accessed,
  version,                    // knot 拡張。エディタと PUT text の baseVersion 用
  persistent: true,
  lines: [{ id, text, userId, created, updated }],
  links: [<前方リンクの原文タイトル>],
  relatedPages: { links1hop: [...], links2hop: [...], hasBackLinksOrIcons: <bool> },
  collaborators: [],
  lastAccessed: updated
}

GET /api/pages/:project/search/titles
200 [{ id, title, hasIcon, updated, links: [<原文タイトル>] }]
```

- [ ] **Step 1: storage の失敗するテストを書く**

`test/storage/related.test.ts`（`seedPage` は Task 7 の `test/helpers/pages.ts` から import）:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';

const now = 1700000000;

test('getRelatedPages: 1-hop は前方リンク先と逆リンク元', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Fwd] and [Red Link]'], now);
  await seedPage(storage, project.id, 'Fwd', ['content'], now + 1);
  await seedPage(storage, project.id, 'Back', ['see [Home]'], now + 2);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  const oneHop = rel.links1hop.map((p) => p.title).sort();
  assert.deepEqual(oneHop, ['Back', 'Fwd']); // 赤リンク 'Red Link' はページが無いので含まれない
  assert.equal(rel.hasBackLinks, true);
});

test('getRelatedPages: 2-hop は前方リンク先を共有するページ', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Shared Topic]'], now);
  await seedPage(storage, project.id, 'Sibling', ['also [Shared Topic]'], now + 1);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.deepEqual(rel.links1hop, []); // Shared Topic は赤リンク
  assert.deepEqual(rel.links2hop.map((p) => p.title), ['Sibling']);
  assert.deepEqual(rel.links2hop[0].linksLc, ['shared_topic']);
  assert.equal(rel.hasBackLinks, false);
});

test('getRelatedPages: 1-hop に入ったページは 2-hop から除外', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Fwd] [Topic]'], now);
  await seedPage(storage, project.id, 'Fwd', ['[Topic]'], now + 1); // 1hop であり Topic 共有でもある
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.deepEqual(rel.links1hop.map((p) => p.title), ['Fwd']);
  assert.deepEqual(rel.links2hop, []);
});

test('アイコン参照だけの逆リンクでも hasBackLinks が立つ（hasBackLinksOrIcons の実体）', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['content'], now);
  await seedPage(storage, project.id, 'User Page', ['by [Home.icon]'], now + 1);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.equal(rel.hasBackLinks, true);
});

test('listPageTitles: 原文タイトルのリンクを返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Page One', ['[Foo Bar] #tag', 'https://i.gyazo.com/x.png'], now);
  const titles = await storage.listPageTitles(project.id);
  assert.equal(titles.length, 1);
  assert.equal(titles[0].title, 'Page One');
  assert.equal(titles[0].hasIcon, true); // image がある
  assert.deepEqual(titles[0].links.sort(), ['Foo Bar', 'tag']);
});
```

- [ ] **Step 2: 失敗を確認し、storage を実装する**

Run: `direnv exec . npm test` → FAIL（メソッド不在）。

`src/storage/sqlite.ts` に追加:

```ts
  #relatedDescriptions(pageId: string): string[] {
    return (
      this.#db
        .prepare("SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5")
        .all(pageId) as { text: string }[]
    ).map((r) => r.text);
  }

  #linkedCount(projectId: string, titleLcValue: string): number {
    return (
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM links WHERE project_id = ? AND target_title_lc = ?')
        .get(projectId, titleLcValue) as { n: number }
    ).n;
  }

  #outboundLc(pageId: string): string[] {
    return (
      this.#db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all(pageId) as {
        target_title_lc: string;
      }[]
    ).map((r) => r.target_title_lc);
  }

  #toRelatedPage(row: PageRow, linksLc: string[]): RelatedPage {
    return {
      id: row.id,
      title: row.title,
      titleLc: row.title_lc,
      image: row.image,
      descriptions: this.#relatedDescriptions(row.id),
      linksLc,
      linked: this.#linkedCount(row.project_id, row.title_lc),
      updated: row.updated,
    };
  }

  async getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages> {
    const targets = this.#outboundLc(pageId);
    const placeholders = targets.map(() => '?').join(', ');

    const forward =
      targets.length === 0
        ? []
        : (this.#db
            .prepare(
              `SELECT * FROM pages WHERE project_id = ? AND deleted = 0 AND id != ? AND title_lc IN (${placeholders})`,
            )
            .all(projectId, pageId, ...targets) as PageRow[]);

    const back = this.#db
      .prepare(
        `SELECT p.* FROM pages p JOIN links l ON l.source_page_id = p.id
         WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
      )
      .all(projectId, titleLcValue, pageId) as PageRow[];

    const oneHop = new Map<string, PageRow>();
    for (const row of [...forward, ...back]) oneHop.set(row.id, row);
    const links1hop = [...oneHop.values()].map((row) => this.#toRelatedPage(row, this.#outboundLc(row.id)));

    let links2hop: RelatedPage[] = [];
    if (targets.length > 0) {
      const rows = this.#db
        .prepare(
          `SELECT p.*, l.target_title_lc AS shared FROM pages p JOIN links l ON l.source_page_id = p.id
           WHERE l.project_id = ? AND l.target_title_lc IN (${placeholders}) AND p.deleted = 0`,
        )
        .all(projectId, ...targets) as (PageRow & { shared: string })[];
      const byPage = new Map<string, { row: PageRow; shared: string[] }>();
      for (const row of rows) {
        if (row.id === pageId || oneHop.has(row.id)) continue;
        const entry = byPage.get(row.id) ?? { row, shared: [] };
        entry.shared.push(row.shared);
        byPage.set(row.id, entry);
      }
      links2hop = [...byPage.values()].map(({ row, shared }) => this.#toRelatedPage(row, shared));
    }

    return { links1hop, links2hop, hasBackLinks: back.length > 0, linked: this.#linkedCount(projectId, titleLcValue) };
  }

  async listPageTitles(projectId: string): Promise<TitleEntry[]> {
    const rows = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id')
      .all(projectId) as PageRow[];
    const linksStmt = this.#db.prepare('SELECT target_title FROM links WHERE source_page_id = ?');
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hasIcon: r.image !== null,
      updated: r.updated,
      links: (linksStmt.all(r.id) as { target_title: string }[]).map((l) => l.target_title),
    }));
  }
```

Run: `direnv exec . npm test` → storage テスト PASS を確認。

- [ ] **Step 3: ルートの失敗するテストを書く**

`test/server/read-page.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

test('GET /api/pages/:project/:title が lines / links / relatedPages を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Home', ['see [Sub Page] and [Red]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Sub Page', ['back to [Home]'], s.clock.t + 1);
  const res = await s.request('/api/pages/proj/Home', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'Home');
  assert.equal(body.persistent, true);
  assert.equal(typeof body.version, 'number'); // knot 拡張
  assert.equal(body.lines[0].text, 'Home');
  assert.deepEqual(body.links.sort(), ['Red', 'Sub Page']); // 前方リンクの原文（赤リンク含む）
  assert.deepEqual(body.relatedPages.links1hop.map((p: { title: string }) => p.title), ['Sub Page']);
  assert.equal(body.relatedPages.hasBackLinksOrIcons, true);
  assert.equal(body.linked, 1); // Sub Page からの被リンク
  assert.equal((await s.request('/api/pages/proj/None', {}, cookie)).status, 404);
});

test('GET /api/pages/:project/search/titles', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Page One', ['[Foo Bar]'], s.clock.t);
  const res = await s.request('/api/pages/proj/search/titles', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, [
    { id: body[0].id, title: 'Page One', hasIcon: false, updated: body[0].updated, links: ['Foo Bar'] },
  ]);
});
```

- [ ] **Step 4: 失敗を確認し、ルートを実装する**

`src/server/routes/read.ts` に追加（**search 系のルートを `/:title` 系より先に登録する**）:

```ts
  app.get('/api/pages/:project/search/titles', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    return c.json(await storage.listPageTitles(project.id));
  });

  app.get('/api/pages/:project/:title', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const related = await storage.getRelatedPages(project.id, page.id, page.titleLc);
    const titles = await storage.listPageTitles(project.id); // 前方リンク原文の取得
    const links = titles.find((t) => t.id === page.id)?.links ?? [];
    const descriptions = page.lines.slice(1).filter((l) => l.text !== '').slice(0, 5).map((l) => l.text);
    const relatedToJson = (p: RelatedPage) => ({
      id: p.id, title: p.title, titleLc: p.titleLc, image: p.image, descriptions: p.descriptions,
      linksLc: p.linksLc, linked: p.linked, updated: p.updated, accessed: p.updated,
    });
    return c.json({
      id: page.id,
      title: page.title,
      image: page.image,
      descriptions,
      pin: page.pinned,
      views: 0,
      linked: related.linked,
      created: page.created,
      updated: page.updated,
      accessed: page.updated,
      version: page.version,
      persistent: true,
      lines: page.lines.map((l) => ({ id: l.id, text: l.text, userId: l.userId, created: l.created, updated: l.updated })),
      links,
      relatedPages: {
        links1hop: related.links1hop.map(relatedToJson),
        links2hop: related.links2hop.map(relatedToJson),
        hasBackLinksOrIcons: related.hasBackLinks,
      },
      collaborators: [],
      lastAccessed: page.updated,
    });
  });
```

`titles.find(...)` は全ページ分のリンクを引くので最適化余地があるが、v1 の規模では許容する（`listPageTitles` はどのみち search/titles 用に実装済み）。

- [ ] **Step 5: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 6: Commit**

```bash
git add src/storage src/server test/storage/related.test.ts test/server/read-page.test.ts
git commit -m "feat(server): ページ本体 API と relatedPages / search/titles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: 読み取り API (3): search/query と /api/code

**Files:**
- Modify: `src/storage/types.ts`（`SearchHit` に `image` を追加）
- Modify: `src/storage/sqlite.ts`（search の SELECT に image を含める）
- Modify: `src/server/routes/read.ts`
- Test: `test/storage/search.test.ts`（image の期待を追記）、`test/server/read-search.test.ts`

**Interfaces:**
- Consumes: `Storage.search`（実装済み。FTS5 3 文字以上 / LIKE フォールバック）、`@progfay/scrapbox-parser` の `parse`
- Produces: `SearchHit = { pageId: string; title: string; image: string | null; lines: string[] }`。ルートは以下の形状:

```
GET /api/pages/:project/search/query?q=<query>
200 {
  projectName, searchQuery: q, query: { words: [q を空白で分割], excludes: [] },
  limit: 100, count, existsExactTitleMatch,
  pages: [{ id, title, image, words: [同上], lines: [マッチ行] }]
}
q が無い・空・空白のみは 400。検索はフレーズ検索（storage.search の仕様。複数語の OR/AND はしない — 既知の制限）
pages は宣言どおり先頭 100 件に切り詰める（count は総ヒット数）

GET /api/code/:project/:title/:filename
200 text/plain — ページ内の `code:<filename>` ブロックの内容。同名ブロックが複数あれば '\n' で連結
404 — ページまたは該当ファイル名のコードブロックがない
```

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/search.test.ts` に追記:

```ts
test('SearchHit に image が含まれる', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'With Image', ['needle here', 'https://i.gyazo.com/x.png'], now);
  await seedPage(storage, project.id, 'No Image', ['needle too'], now + 1);
  const hits = await storage.search(project.id, 'needle');
  assert.equal(hits.find((h) => h.title === 'With Image')!.image, 'https://i.gyazo.com/x.png');
  assert.equal(hits.find((h) => h.title === 'No Image')!.image, null);
});
```

（import は既存の search.test.ts に合わせて `seedPage` を `../helpers/pages.ts` から足す。既存テストがページを別の方法で組み立てていてもこのテストは独立して動く。）

`test/server/read-search.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function login(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  await s.addUser('alice', 'pw12345678');
  return s.login('alice', 'pw12345678');
}

test('search/query が Cosense 形状で返す', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Hit Page', ['this line has needle inside'], s.clock.t);
  await seedPage(s.storage, project.id, 'Other', ['nothing here'], s.clock.t + 1);
  const res = await s.request('/api/pages/proj/search/query?q=needle', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projectName, 'proj');
  assert.equal(body.searchQuery, 'needle');
  assert.deepEqual(body.query, { words: ['needle'], excludes: [] });
  assert.equal(body.count, 1);
  assert.equal(body.existsExactTitleMatch, false);
  assert.equal(body.pages[0].title, 'Hit Page');
  assert.deepEqual(body.pages[0].lines, ['this line has needle inside']);
  assert.equal((await s.request('/api/pages/proj/search/query', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj/search/query?q=', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj/search/query?q=%20%20', {}, cookie)).status, 400);
});

test('existsExactTitleMatch はタイトル lc 一致で true', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Needle', ['needle body'], s.clock.t);
  const res = await s.request('/api/pages/proj/search/query?q=needle', {}, cookie);
  const body = await res.json();
  assert.equal(body.existsExactTitleMatch, true);
});

test('/api/code はコードブロックを返す', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Code Page', [
    'code:sample.js',
    ' const a = 1;',
    ' const b = 2;',
    'between',
    'code:sample.js',
    ' const c = 3;',
    'code:other.txt',
    ' unrelated',
  ], s.clock.t);
  const res = await s.request('/api/code/proj/Code%20Page/sample.js', {}, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^text\/plain/);
  assert.equal(await res.text(), 'const a = 1;\nconst b = 2;\nconst c = 3;');
  assert.equal((await s.request('/api/code/proj/Code%20Page/nope.js', {}, cookie)).status, 404);
  assert.equal((await s.request('/api/code/proj/None/x.js', {}, cookie)).status, 404);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（search/query ルートなし → 404、SearchHit.image なし）

- [ ] **Step 3: 実装する**

`src/storage/types.ts`: `SearchHit` を `{ pageId: string; title: string; image: string | null; lines: string[] }` に変更。

`src/storage/sqlite.ts`: `#searchFts` / `#searchLike` の SELECT に `p.image` を含め、`search()` の map で `image: p.image` を返す。

`src/server/routes/read.ts` に追加（search/titles と同じく `/:title` より先に登録）:

```ts
  app.get('/api/pages/:project/search/query', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const q = c.req.query('q');
    if (q === undefined || q.trim() === '') return jsonError(c, 400, 'bad_request', { message: 'q required' });
    const hits = await storage.search(project.id, q);
    const words = q.split(/\s+/).filter((w) => w !== '');
    return c.json({
      projectName: project.name,
      searchQuery: q,
      query: { words, excludes: [] },
      limit: 100,
      count: hits.length, // 総ヒット数
      existsExactTitleMatch: hits.some((h) => titleLc(h.title) === titleLc(q)),
      pages: hits
        .slice(0, 100) // 宣言した limit を超えて返さない
        .map((h) => ({ id: h.pageId, title: h.title, image: h.image, words, lines: h.lines })),
    });
  });

  app.get('/api/code/:project/:title/:filename', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const filename = safeDecode(c.req.param('filename'));
    if (filename === null) return jsonError(c, 404, 'not_found');
    const blocks = parse(page.lines.map((l) => l.text).join('\n'), { hasTitle: true });
    const contents: string[] = [];
    for (const block of blocks) {
      if (block.type === 'codeBlock' && block.fileName === filename) contents.push(block.content);
    }
    if (contents.length === 0) return jsonError(c, 404, 'not_found');
    return c.text(contents.join('\n'));
  });
```

read.ts の import に `parse`（scrapbox-parser）と `titleLc` を追加する。

注: `/api/code` のテスト期待値は「`codeBlock.content` はインデント（行頭 1 段）を除去した内容」というパーサ挙動を前提にしている。Step 2 の FAIL 確認時に実挙動が異なったら（content がインデントを保持していたら）、**仕様は「content をそのまま返す」のままテスト期待値だけを実挙動に合わせる**。ルート側で独自にインデントを剥がす実装はしない。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/storage src/server test/storage/search.test.ts test/server/read-search.test.ts
git commit -m "feat(server): 全文検索 API と /api/code のコードブロック抽出

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 10: コミット API（409 payload の確定）

書き込みの正準経路 `POST /api/knot/pages/:project/:title/commits`。
plan-02 持ち越しの「title conflict payload の API 設計」をここで確定する:
**409 応答は `{error: 'conflict', reason: 'version' | 'title', page: <pageToJson 形状>}`。
`reason: 'version'` の `page` は対象ページの最新スナップショット（`rebase()` の `latestSnapshot` 入力にそのまま使える）。
`reason: 'title'` の `page` はそのタイトルを占有している別ページ。リベース + 再送の対象は `reason: 'version'` のみ**（storage の `CommitResult` と同じ意味論を HTTP に写す）。

**Files:**
- Create: `src/server/routes/write.ts`
- Modify: `src/server/app.ts`（`registerWriteRoutes` の呼び出し追加）
- Test: `test/server/commit-api.test.ts`

**Interfaces:**
- Consumes: `Storage.commit`（実装済み）、`applyOps`（core、新規ページの事前検証に使う）、`pageToJson` / `resolveProject` / `resolvePage`（Task 6-7）、`ulid`
- Produces: `registerWriteRoutes(app: Hono<ApiEnv>, deps: AppDeps): void`。エンドポイント仕様:

```
POST /api/knot/pages/:project/:title/commits
body: { commitId: string, baseVersion: number, ops: LineOp[] }
200 { version }                            適用済み（冪等な再送は最初の version を返す）
409 { error: 'conflict', reason, page }    上記
400 { error: 'bad_commit' | 'bad_request', message }
404 { error: 'not_found' }                 プロジェクト不在、またはページ不在で baseVersion != 0
```

- ページが存在しない場合は新規作成: `baseVersion` は 0 でなければ 404。サーバが新しい pageId（ULID）を発行する。
- 新規作成では、ops を空ページに適用した結果の先頭行の titleLc が URL の :title の titleLc と一致しなければ 400（URL と実体の乖離を防ぐ。既存ページへのコミットはタイトル変更として扱われるので制約しない）。
- body の形式検証（commitId が非空 string、baseVersion が非負整数、ops が LineOp 形の配列）に失敗したら 400 `bad_request`。ops の意味的検証（行 ID 不在など）は storage が `BadCommitError` で報告し 400 `bad_commit`。
- userId はセッションから（`c.get('userId')`）。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/commit-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { ulid } from '../../src/core/id.ts';

async function setup() {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const post = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/commits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  return { s, cookie, userId, post };
}

test('新規作成 → 編集 → 冪等な再送', async () => {
  const { s, post, userId } = await setup();
  const l1 = ulid();
  const create = await post('New Page', {
    commitId: ulid(), baseVersion: 0,
    ops: [{ type: 'insert', id: l1, after: '_head', text: 'New Page' }],
  });
  assert.equal(create.status, 200);
  assert.deepEqual(await create.json(), { version: 1 });

  const editId = ulid();
  const edit = { commitId: editId, baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'New Page!' }] };
  const first = await post('New Page', edit);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { version: 2 });
  const resend = await post('New Page!', edit); // タイトルが変わったので URL も新タイトル
  assert.equal(resend.status, 200);
  assert.deepEqual(await resend.json(), { version: 2 }); // 冪等: 最初の version

  // 行の userId はセッションユーザー
  const project = await s.storage.getProject('proj');
  const page = await s.storage.getPageByTitle(project!.id, 'new_page!');
  assert.equal(page!.lines[0].userId, userId);
});

test('baseVersion 不一致は 409 reason version で最新状態を返す', async () => {
  const { post } = await setup();
  const l1 = ulid();
  await post('P', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: l1, after: '_head', text: 'P' }] });
  await post('P', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'P2' }] });
  const stale = await post('P2', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'P3' }] });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error, 'conflict');
  assert.equal(body.reason, 'version');
  assert.equal(body.page.version, 2);
  assert.equal(body.page.lines[0].text, 'P2'); // rebase の latestSnapshot に使える全行
});

test('タイトル衝突は 409 reason title で占有ページを返す', async () => {
  const { post } = await setup();
  await post('Taken', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'Taken' }] });
  const l1 = ulid();
  await post('Other', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: l1, after: '_head', text: 'Other' }] });
  const clash = await post('Other', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'Taken' }] });
  assert.equal(clash.status, 409);
  const body = await clash.json();
  assert.equal(body.reason, 'title');
  assert.equal(body.page.title, 'Taken'); // 占有している別ページ
});

test('クライアント不正は 400', async () => {
  const { post } = await setup();
  // 存在しない行への update
  await post('P', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'P' }] });
  const bad = await post('P', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: ulid(), text: 'x' }] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_commit');
  // 形式不正
  const malformed = await post('P', { commitId: '', baseVersion: 1, ops: [] });
  assert.equal(malformed.status, 400);
  const noJson = await post('P', undefined); // body なし
  assert.equal(noJson.status, 400);
});

test('新規作成の制約: baseVersion != 0 は 404、URL とタイトル不一致は 400', async () => {
  const { post } = await setup();
  const notFound = await post('Ghost', { commitId: ulid(), baseVersion: 3, ops: [{ type: 'update', id: ulid(), text: 'x' }] });
  assert.equal(notFound.status, 404);
  const mismatch = await post('Expected Title', {
    commitId: ulid(), baseVersion: 0,
    ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'Different Title' }],
  });
  assert.equal(mismatch.status, 400);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（ルート未定義で 404）

- [ ] **Step 3: 実装する**

`src/server/routes/write.ts`:

```ts
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { ulid } from '../../core/id.ts';
import { applyOps } from '../../core/apply.ts';
import { OpsError, type LineOp } from '../../core/ops.ts';
import { titleLc } from '../../core/title.ts';
import { BadCommitError, type CommitResult, type Storage } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, pageToJson, resolveProject, resolvePage, safeDecode, type ApiEnv } from '../http.ts';

function isLineOp(op: unknown): op is LineOp {
  if (typeof op !== 'object' || op === null) return false;
  const o = op as Record<string, unknown>;
  if (o.type === 'insert') return typeof o.id === 'string' && typeof o.after === 'string' && typeof o.text === 'string';
  if (o.type === 'update') return typeof o.id === 'string' && typeof o.text === 'string';
  if (o.type === 'delete') return typeof o.id === 'string';
  return false;
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function commitResultToResponse(c: Context, result: CommitResult): Response {
  if (result.kind === 'applied') return c.json({ version: result.version });
  return jsonError(c, 409, 'conflict', { reason: result.reason, page: pageToJson(result.page) });
}

export function registerWriteRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  app.post('/api/knot/pages/:project/:title/commits', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    const { commitId, baseVersion, ops } = body;
    if (
      typeof commitId !== 'string' || commitId === '' ||
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      !Array.isArray(ops) || ops.length === 0 || !ops.every(isLineOp)
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'commitId, baseVersion, ops required' });
    }

    const rawTitle = safeDecode(c.req.param('title'));
    if (rawTitle === null) return jsonError(c, 404, 'not_found');
    const urlTitleLc = titleLc(rawTitle);
    const page = await storage.getPageByTitle(project.id, urlTitleLc);
    let pageId: string;
    if (page) {
      pageId = page.id;
    } else {
      if (baseVersion !== 0) return jsonError(c, 404, 'not_found');
      // 新規作成: 適用結果の先頭行タイトルが URL と一致することを純関数で事前検証する
      try {
        const lines = applyOps([], ops, { userId: c.get('userId'), now: now(), version: 1 });
        if (lines.length === 0 || titleLc(lines[0].text) !== urlTitleLc) {
          return jsonError(c, 400, 'bad_request', { message: 'first line must match the URL title' });
        }
      } catch (e) {
        if (e instanceof OpsError) return jsonError(c, 400, 'bad_commit', { message: e.message });
        throw e;
      }
      pageId = ulid(now() * 1000);
    }

    try {
      const result = await storage.commit({
        projectId: project.id, pageId, commitId, baseVersion, ops,
        userId: c.get('userId'), now: now(),
      });
      return commitResultToResponse(c, result);
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_commit', { message: e.message });
      throw e;
    }
  });
}
```

`src/server/app.ts` に `registerWriteRoutes(app, deps)` の呼び出しを追加（read の後でよい）。

注: 新規作成の「再送」で、1 回目が適用済みだと 2 回目はページが存在して `baseVersion: 0 != version 1` の経路に入るが、storage の冪等判定（commitId + ops_hash）が先に効いて最初の version を返す（`#applyCommit` は prior チェックが最初）。この経路のテストが「冪等な再送」テストでカバーされる（タイトル変更後の URL 再送も同様）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/server test/server/commit-api.test.ts
git commit -m "feat(server): 行操作のコミット API（409 は reason と最新状態を返す）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: PUT text（全文置換の簡易経路）

行 ID を知らないクライアント向け。`{baseVersion, text}` を受け取り、サーバが LCS 差分（core の `diffLines`）で行操作に変換して通常のコミットにする。

**Files:**
- Modify: `src/server/routes/write.ts`
- Test: `test/server/text-api.test.ts`

**Interfaces:**
- Consumes: `diffLines(oldLines: Line[], newTexts: string[], makeId: () => string): LineOp[]`（core、実装済み）、Task 10 の `commitResultToResponse` / `readJson`
- Produces:

```
PUT /api/knot/pages/:project/:title/text
body: { baseVersion: number, text: string }
200 { version, commitId }        適用（commitId はサーバが発行した ULID）
200 { version, commitId: null }  差分なし（コミットを作らない）
409 { error: 'conflict', reason, page }   baseVersion 不一致（reason 'version'）またはタイトル衝突
400 / 404                        形式不正 / プロジェクト不在・ページ不在で baseVersion != 0
```

- text の行分割は `text.split('\n')` そのまま（`GET .../text` の `join('\n')` の逆）。空文字列は「0 行」ではなく 400（ページは最低 1 行）。
- 新規作成（ページ不在 + baseVersion 0）も同じ経路: `diffLines([], texts, ...)` が insert 列を作る。先頭行の titleLc が URL と一致しない場合 400（Task 10 と同じ制約）。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/text-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

async function setup() {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const put = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  const getText = (title: string) => s.request(`/api/pages/proj/${encodeURIComponent(title)}/text`, {}, cookie);
  return { s, put, getText };
}

test('新規作成 → 全文置換 → GET text で往復', async () => {
  const { put, getText } = await setup();
  const create = await put('Doc', { baseVersion: 0, text: 'Doc\nline one\nline two' });
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.version, 1);
  assert.match(created.commitId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

  const update = await put('Doc', { baseVersion: 1, text: 'Doc\nline one changed\nline two\nline three' });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).version, 2);
  assert.equal(await (await getText('Doc')).text(), 'Doc\nline one changed\nline two\nline three');
});

test('変更のない PUT はコミットを作らない', async () => {
  const { put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nsame' });
  const noop = await put('Doc', { baseVersion: 1, text: 'Doc\nsame' });
  assert.equal(noop.status, 200);
  assert.deepEqual(await noop.json(), { version: 1, commitId: null });
});

test('baseVersion 不一致は 409 で最新状態を返す', async () => {
  const { put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nv1' });
  await put('Doc', { baseVersion: 1, text: 'Doc\nv2' });
  const stale = await put('Doc', { baseVersion: 1, text: 'Doc\nv3' });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.reason, 'version');
  assert.equal(body.page.lines.map((l: { text: string }) => l.text).join('\n'), 'Doc\nv2');
});

test('編集で残った行の ID とメタデータは保持される', async () => {
  const { s, put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nkeep me\ndrop me' });
  const project = await s.storage.getProject('proj');
  const before = await s.storage.getPageByTitle(project!.id, 'doc');
  const keepId = before!.lines[1].id;
  await put('Doc', { baseVersion: 1, text: 'Doc\nkeep me\nnew line' });
  const after = await s.storage.getPageByTitle(project!.id, 'doc');
  assert.equal(after!.lines[1].id, keepId); // 不変の行は ID が変わらない
});

test('形式不正は 400', async () => {
  const { put } = await setup();
  assert.equal((await put('Doc', { baseVersion: 0, text: '' })).status, 400);
  assert.equal((await put('Doc', { baseVersion: 0 })).status, 400);
  assert.equal((await put('Doc', { baseVersion: -1, text: 'Doc' })).status, 400);
  // 新規作成で先頭行が URL タイトルと不一致
  assert.equal((await put('Doc', { baseVersion: 0, text: 'Other\nbody' })).status, 400);
  // ページ不在で baseVersion != 0
  assert.equal((await put('Ghost', { baseVersion: 2, text: 'Ghost' })).status, 404);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（ルート未定義で 404）

- [ ] **Step 3: 実装する**

`src/server/routes/write.ts` の `registerWriteRoutes` に追加:

```ts
  app.put('/api/knot/pages/:project/:title/text', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    const { baseVersion, text } = body;
    if (
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      typeof text !== 'string' || text === ''
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'baseVersion and non-empty text required' });
    }

    const rawTitle = safeDecode(c.req.param('title'));
    if (rawTitle === null) return jsonError(c, 404, 'not_found');
    const urlTitleLc = titleLc(rawTitle);
    const newTexts = text.split('\n');
    const page = await storage.getPageByTitle(project.id, urlTitleLc);
    if (!page && baseVersion !== 0) return jsonError(c, 404, 'not_found');
    if (!page && titleLc(newTexts[0]) !== urlTitleLc) {
      return jsonError(c, 400, 'bad_request', { message: 'first line must match the URL title' });
    }
    if (page && baseVersion !== page.version) {
      return jsonError(c, 409, 'conflict', { reason: 'version', page: pageToJson(page) });
    }

    const currentLines = page ? page.lines : [];
    const ops = diffLines(currentLines, newTexts, () => ulid(now() * 1000));
    if (ops.length === 0) return c.json({ version: page!.version, commitId: null });

    const commitId = ulid(now() * 1000);
    try {
      const result = await storage.commit({
        projectId: project.id,
        pageId: page ? page.id : ulid(now() * 1000),
        commitId, baseVersion, ops, userId: c.get('userId'), now: now(),
      });
      if (result.kind === 'applied') return c.json({ version: result.version, commitId });
      return commitResultToResponse(c, result);
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_commit', { message: e.message });
      throw e;
    }
  });
```

（`diffLines` を import に追加。GET と commit の間の他者コミットは storage 側の baseVersion 検査が 409 で拾う。）

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/server test/server/text-api.test.ts
git commit -m "feat(server): PUT text による全文置換（LCS 差分を通常コミットに変換）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: rename（リンク元書き換えオプション付き）

タイトル変更は「タイトル行の update」のコミット 1 件。`rewriteLinks: true` ならリンク元ページの書き換えも各ページへの通常コミットとして、**全体を単一トランザクション**で適用する（全部成功か全部失敗）。

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/server/routes/write.ts`
- Test: `test/storage/rename.test.ts`、`test/server/rename-api.test.ts`

**Interfaces:**
- Consumes: `rewritePageLinks`（Task 3）、`#applyCommit` / `#tx`（sqlite 内部）、links テーブル（target_title_lc）
- Produces:

```ts
// storage
export type RenameInput = {
  projectId: string; pageId: string; baseVersion: number;
  newTitle: string; rewriteLinks: boolean; userId: string; now: number;
};
export type RenameResult =
  | { kind: 'applied'; version: number; rewritten: { pageId: string; title: string; version: number }[] }
  // reason 'version': baseVersion 不一致（page は対象ページの最新）。'title': 新タイトルの占有ページ
  | { kind: 'conflict'; reason: 'version' | 'title'; page: PageSnapshot };
// interface Storage に追加:
  /** タイトル変更 + 任意でリンク元書き換え。単一トランザクションで全部成功か全部失敗 */
  renamePage(input: RenameInput): Promise<RenameResult>;
```

```
POST /api/knot/pages/:project/:title/rename
body: { baseVersion: number, newTitle: string, rewriteLinks?: boolean }   // rewriteLinks 既定 false
200 { title, version, rewritten: [{ id, title, version }] }
409 { error: 'conflict', reason: 'version' | 'title', page }
400 { error: 'bad_request' | 'bad_commit', message }  // newTitle が空、変更なし等
404 プロジェクトまたはページ不在
```

`baseVersion` はクライアントが観測した対象ページの version。これがないと、他者が直前に加えた変更を
見ないままタイトル行を上書きできてしまう（コミット API の競合検出の原則を rename だけ迂回しない）。

- [ ] **Step 1: storage の失敗するテストを書く**

`test/storage/rename.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { ulid } from '../../src/core/id.ts';
import { BadCommitError } from '../../src/storage/types.ts';

const now = 1700000000;

test('rename はタイトル行の update コミットに帰着する', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['body'], now);
  const result = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'New', rewriteLinks: false, userId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  const page = await storage.getPageById(pageId);
  assert.equal(page!.title, 'New');
  assert.equal(page!.version, 2); // コミット 1 件分
  assert.equal(page!.lines[0].text, 'New');
  // 旧タイトルでは引けない
  assert.equal(await storage.getPageByTitle(project.id, 'old'), null);
});

test('rewriteLinks: true でリンク元の本文が書き換わり、リンク索引も更新される', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const targetId = await seedPage(storage, project.id, 'Old Name', ['content'], now);
  const srcId = await seedPage(storage, project.id, 'Src', ['see [Old Name] and #old_name'], now + 1);
  const untouchedId = await seedPage(storage, project.id, 'Untouched', ['no links'], now + 2);
  const result = await storage.renamePage({
    projectId: project.id, pageId: targetId, baseVersion: 1, newTitle: 'New Name', rewriteLinks: true, userId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  assert.deepEqual(result.kind === 'applied' ? result.rewritten.map((r) => r.pageId) : [], [srcId]);
  const src = await storage.getPageById(srcId);
  assert.equal(src!.lines[1].text, 'see [New Name] and [New Name]');
  assert.equal(src!.version, 2);
  const untouched = await storage.getPageById(untouchedId);
  assert.equal(untouched!.version, 1); // 無関係ページはコミットされない
  // 書き換え後の links は新タイトルを指す
  const rel = await storage.getRelatedPages(project.id, targetId, 'new_name');
  assert.equal(rel.hasBackLinks, true);
});

test('新タイトルの占有は conflict で全体が失敗する（リンク元も書き換わらない）', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Taken', ['x'], now);
  const targetId = await seedPage(storage, project.id, 'Old', ['x'], now + 1);
  const srcId = await seedPage(storage, project.id, 'Src', ['[Old]'], now + 2);
  const result = await storage.renamePage({
    projectId: project.id, pageId: targetId, baseVersion: 1, newTitle: 'Taken', rewriteLinks: true, userId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'conflict');
  assert.equal(result.kind === 'conflict' ? result.reason : '', 'title');
  assert.equal(result.kind === 'conflict' ? result.page.title : '', 'Taken');
  const src = await storage.getPageById(srcId);
  assert.equal(src!.lines[1].text, '[Old]'); // ロールバックされている
});

test('大文字小文字だけの変更（同じ lc）は衝突しない', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'name', ['x'], now);
  const result = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'Name', rewriteLinks: false, userId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  const page = await storage.getPageById(pageId);
  assert.equal(page!.title, 'Name');
});

test('baseVersion 不一致は conflict reason version で最新を返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['x'], now);
  await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'Mid', rewriteLinks: false, userId: 'u', now: now + 5,
  });
  const stale = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'New', rewriteLinks: false, userId: 'u', now: now + 10,
  });
  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.kind === 'conflict' ? stale.reason : '', 'version');
  assert.equal(stale.kind === 'conflict' ? stale.page.title : '', 'Mid'); // 最新スナップショット
});

test('空タイトルと同一タイトルは BadCommitError', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['x'], now);
  const base = { projectId: project.id, pageId, baseVersion: 1, rewriteLinks: false, userId: 'u', now: now + 10 };
  await assert.rejects(storage.renamePage({ ...base, newTitle: '' }), BadCommitError);
  await assert.rejects(storage.renamePage({ ...base, newTitle: 'Old' }), BadCommitError);
});
```

- [ ] **Step 2: 失敗を確認し、storage を実装する**

Run: `direnv exec . npm test` → FAIL。

`src/storage/sqlite.ts` に追加:

```ts
  async renamePage(input: RenameInput): Promise<RenameResult> {
    const { projectId, pageId, baseVersion, newTitle, rewriteLinks, userId, now } = input;
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
      if (!row || row.deleted === 1) throw new BadCommitError(`unknown page: ${pageId}`);
      if (row.project_id !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
      if (newTitle === '') throw new BadCommitError('title must not be empty');
      if (newTitle === row.title) throw new BadCommitError('title is unchanged');
      if (baseVersion !== row.version) {
        return { kind: 'conflict' as const, reason: 'version' as const, page: this.#snapshot(row) };
      }
      const oldTitleLc = row.title_lc;

      const lines = this.#getLines(pageId);
      const titleCommit = this.#applyCommit({
        projectId, pageId, commitId: ulid(now * 1000), baseVersion,
        ops: [{ type: 'update', id: lines[0].id, text: newTitle }], userId, now,
      });
      if (titleCommit.kind === 'conflict') {
        // baseVersion は検査済みなので、ここに来るのは title 衝突のみ
        return { kind: 'conflict' as const, reason: 'title' as const, page: titleCommit.page };
      }

      const rewritten: { pageId: string; title: string; version: number }[] = [];
      if (rewriteLinks && titleLc(newTitle) !== oldTitleLc) {
        const sources = this.#db
          .prepare(
            `SELECT DISTINCT p.id FROM pages p JOIN links l ON l.source_page_id = p.id
             WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
          )
          .all(projectId, oldTitleLc, pageId) as { id: string }[];
        for (const source of sources) {
          const srcRow = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(source.id) as PageRow;
          const srcLines = this.#getLines(source.id);
          const changes = rewritePageLinks(srcLines.map((l) => l.text), oldTitleLc, newTitle);
          const ops: LineOp[] = [];
          changes.forEach((text, i) => {
            if (text !== null) ops.push({ type: 'update', id: srcLines[i].id, text });
          });
          if (ops.length === 0) continue;
          const result = this.#applyCommit({
            projectId, pageId: source.id, commitId: ulid(now * 1000), baseVersion: srcRow.version, ops, userId, now,
          });
          if (result.kind !== 'applied') {
            // 書き換えはタイトル行に触れないため起きないはずだが、起きたら全体を失敗させる
            throw new StorageError(`link rewrite conflict on page ${source.id}`);
          }
          rewritten.push({ pageId: source.id, title: srcRow.title, version: result.version });
        }
      }
      return { kind: 'applied' as const, version: titleCommit.version, rewritten };
    });
  }
```

（`rewritePageLinks` と `titleLc` は core から import する。）

Run: `direnv exec . npm test` → storage テスト PASS を確認。

- [ ] **Step 3: ルートの失敗するテストを書く**

`test/server/rename-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function setup() {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const rename = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  return { s, project, cookie, rename };
}

test('rename がタイトルを変え、rewritten を返す', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Old Name', ['content'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old Name]'], s.clock.t + 1);
  const res = await rename('Old Name', { baseVersion: 1, newTitle: 'New Name', rewriteLinks: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'New Name');
  assert.deepEqual(body.rewritten, [{ id: srcId, title: 'Src', version: 2 }]);
});

test('rewriteLinks 省略時は書き換えない', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old]'], s.clock.t + 1);
  const res = await rename('Old', { baseVersion: 1, newTitle: 'New' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).rewritten, []);
  const src = await s.storage.getPageById(srcId);
  assert.equal(src!.lines[1].text, '[Old]');
});

test('占有タイトルへの rename は 409 reason title、baseVersion 不一致は 409 reason version', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Taken', ['x'], s.clock.t);
  await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t + 1);
  const res = await rename('Old', { baseVersion: 1, newTitle: 'Taken' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'title');
  assert.equal(body.page.title, 'Taken');
  const stale = await rename('Old', { baseVersion: 9, newTitle: 'Fresh' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).reason, 'version');
});

test('不正な body は 400、不在ページは 404', async () => {
  const { rename } = await setup();
  assert.equal((await rename('Ghost', { baseVersion: 1, newTitle: 'X' })).status, 404);
  const { s, project, rename: rename2 } = await setup();
  await seedPage(s.storage, project.id, 'P', ['x'], s.clock.t);
  assert.equal((await rename2('P', { baseVersion: 1, newTitle: '' })).status, 400);
  assert.equal((await rename2('P', { baseVersion: 1 })).status, 400);
  assert.equal((await rename2('P', { newTitle: 'X' })).status, 400); // baseVersion なし
  assert.equal((await rename2('P', { baseVersion: 1, newTitle: 'P' })).status, 400); // 変更なし
});
```

- [ ] **Step 4: 失敗を確認し、ルートを実装する**

`src/server/routes/write.ts` の `registerWriteRoutes` に追加:

```ts
  app.post('/api/knot/pages/:project/:title/rename', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (
      !body || typeof body.newTitle !== 'string' ||
      typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 0
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'baseVersion and newTitle required' });
    }
    const rewriteLinks = body.rewriteLinks === true;
    try {
      const result = await storage.renamePage({
        projectId: project.id, pageId: page.id, baseVersion: body.baseVersion, newTitle: body.newTitle,
        rewriteLinks, userId: c.get('userId'), now: now(),
      });
      if (result.kind === 'conflict') {
        return jsonError(c, 409, 'conflict', { reason: result.reason, page: pageToJson(result.page) });
      }
      return c.json({
        title: body.newTitle,
        version: result.version,
        rewritten: result.rewritten.map((r) => ({ id: r.pageId, title: r.title, version: r.version })),
      });
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_request', { message: e.message });
      throw e;
    }
  });
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 6: Commit**

```bash
git add src/storage src/server test/storage/rename.test.ts test/server/rename-api.test.ts
git commit -m "feat(server): rename API（リンク元書き換えを単一トランザクションで適用）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: ページ削除 API

削除は「全行の delete」のコミット。pages 行と commits は保持され、`pages.deleted` が立つ（storage 実装済みの意味論）。

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Modify: `src/server/routes/write.ts`
- Test: `test/storage/delete.test.ts`、`test/server/delete-api.test.ts`

**Interfaces:**
- Consumes: `#applyCommit` / `#tx`（sqlite 内部）
- Produces:

```ts
// interface Storage に追加:
  /** 全行 delete のコミットとしてページを削除する。不在・削除済みは BadCommitError */
  deletePage(projectId: string, pageId: string, userId: string, now: number): Promise<{ version: number }>;
```

```
DELETE /api/knot/pages/:project/:title
200 { deleted: true, version }
404 プロジェクトまたはページ不在（削除済み含む）
```

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/delete.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { BadCommitError } from '../../src/storage/types.ts';

const now = 1700000000;

test('deletePage で deleted が立ち、タイトル解決から消え、commits は残る', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Doomed', ['a', 'b'], now);
  const { version } = await storage.deletePage(project.id, pageId, 'u', now + 10);
  assert.equal(version, 2);
  assert.equal(await storage.getPageByTitle(project.id, 'doomed'), null);
  const page = await storage.getPageById(pageId);
  assert.equal(page!.deleted, true);
  assert.deepEqual(page!.lines, []);
  // 二重削除は BadCommitError
  await assert.rejects(storage.deletePage(project.id, pageId, 'u', now + 20), BadCommitError);
});

test('削除後に同タイトルの新ページを作れる', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const oldId = await seedPage(storage, project.id, 'Title', ['x'], now);
  await storage.deletePage(project.id, oldId, 'u', now + 10);
  const newId = await seedPage(storage, project.id, 'Title', ['y'], now + 20);
  assert.notEqual(newId, oldId);
  const page = await storage.getPageByTitle(project.id, 'title');
  assert.equal(page!.id, newId);
});
```

`test/server/delete-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

test('DELETE でページが消え、以後の GET は 404', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Doomed', ['x'], s.clock.t);
  const res = await s.request('/api/knot/pages/proj/Doomed', { method: 'DELETE' }, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal((await s.request('/api/pages/proj/Doomed', {}, cookie)).status, 404);
  assert.equal((await s.request('/api/knot/pages/proj/Doomed', { method: 'DELETE' }, cookie)).status, 404);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（`deletePage` 不在、ルート未定義）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts`:

```ts
  async deletePage(projectId: string, pageId: string, userId: string, now: number): Promise<{ version: number }> {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
      if (!row || row.deleted === 1) throw new BadCommitError(`unknown page: ${pageId}`);
      if (row.project_id !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
      const ops: LineOp[] = this.#getLines(pageId).map((l) => ({ type: 'delete' as const, id: l.id }));
      const result = this.#applyCommit({
        projectId, pageId, commitId: ulid(now * 1000), baseVersion: row.version, ops, userId, now,
      });
      if (result.kind !== 'applied') throw new StorageError('unexpected conflict in deletePage');
      return { version: result.version };
    });
  }
```

`src/server/routes/write.ts`:

```ts
  app.delete('/api/knot/pages/:project/:title', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const { version } = await storage.deletePage(project.id, page.id, c.get('userId'), now());
    return c.json({ deleted: true, version });
  });
```

（`resolvePage` は deleted=0 のページだけ返すため、二重 DELETE は 404 になり `deletePage` の BadCommitError 経路はルートからは踏まない。）

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/storage src/server test/storage/delete.test.ts test/server/delete-api.test.ts
git commit -m "feat(server): ページ削除 API（全行 delete のコミットとして記録）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 14: import / export API

CLI と同じ `importCosense` / `exportCosense` を HTTP に載せるだけの薄いルート。

**Files:**
- Modify: `src/server/routes/write.ts`
- Modify: `src/core/cosense.ts`（`InvalidExportError` の導入）
- Test: `test/server/import-export-api.test.ts`

**Interfaces:**
- Consumes: `importCosense(storage, data, {projectName, onConflict, now})`、`exportCosense(storage, projectName, format, now)`（実装済み）
- Produces: `export class InvalidExportError extends Error`（core/cosense.ts）。`parseExportFile` の throw をすべてこの型に変える（メッセージは既存のまま。既存テストが `assert.throws(/…/)` でメッセージ照合していればそのまま通る）。加えて以下のルート:

```
POST /api/knot/projects/:project/import?onConflict=skip|overwrite   （既定 skip）
body: Cosense エクスポート JSON そのもの
200 { created, overwritten, skipped, users }    （ImportSummary）
400 { error: 'bad_request', message }           JSON 不正・形式不正・不正なプロジェクト名

GET /api/knot/projects/:project/export?format=full|import           （既定 full）
200 CosenseExport JSON
404 プロジェクト不在
400 不正な format
```

- import はプロジェクトが無ければ作る（`importCosense` の `ensureProject` 経由。CLI と同じ意味論）。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/import-export-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

const exportData = {
  name: 'proj',
  displayName: 'Proj',
  exported: 1700000000,
  users: [{ id: 'a'.repeat(24), name: 'bob', displayName: 'Bob' }],
  pages: [{
    id: '0'.repeat(24), title: 'Imported', created: 1600000000, updated: 1600000001,
    lines: [
      { id: '1'.repeat(24), text: 'Imported', userId: 'a'.repeat(24), created: 1600000000, updated: 1600000000 },
      { id: '2'.repeat(24), text: 'body [Link]', userId: 'a'.repeat(24), created: 1600000000, updated: 1600000000 },
    ],
  }],
};

async function setup() {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  return { s, cookie };
}

test('import → 読み取り API で見える → export で往復', async () => {
  const { s, cookie } = await setup();
  const imp = await s.request('/api/knot/projects/proj/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exportData),
  }, cookie);
  assert.equal(imp.status, 200);
  const summary = await imp.json();
  assert.equal(summary.created, 1);

  const page = await s.request('/api/pages/proj/Imported', {}, cookie);
  assert.equal(page.status, 200);
  assert.equal((await page.json()).lines[1].text, 'body [Link]');

  const exp = await s.request('/api/knot/projects/proj/export', {}, cookie);
  assert.equal(exp.status, 200);
  const out = await exp.json();
  assert.equal(out.name, 'proj');
  assert.equal(out.displayName, 'Proj');
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].lines[1].text, 'body [Link]');
  assert.ok(out.users.some((u: { name: string }) => u.name === 'bob'));
});

test('onConflict=skip が既定、overwrite 指定で上書き', async () => {
  const { s, cookie } = await setup();
  const post = (query: string) => s.request(`/api/knot/projects/proj/import${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exportData),
  }, cookie);
  await post('');
  const skipped = await (await post('')).json();
  assert.equal(skipped.skipped, 1);
  const overwritten = await (await post('?onConflict=overwrite')).json();
  assert.equal(overwritten.overwritten, 1);
  assert.equal((await post('?onConflict=bogus')).status, 400);
});

test('不正な body と format は 400', async () => {
  const { s, cookie } = await setup();
  const bad = await s.request('/api/knot/projects/proj/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: 'not-an-array' }),
  }, cookie);
  assert.equal(bad.status, 400);
  assert.equal((await s.request('/api/knot/projects/none/export', {}, cookie)).status, 404);
  await s.request('/api/knot/projects/proj/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exportData),
  }, cookie);
  assert.equal((await s.request('/api/knot/projects/proj/export?format=bogus', {}, cookie)).status, 400);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（ルート未定義で 404）

- [ ] **Step 3: 実装する**

`src/server/routes/write.ts` の `registerWriteRoutes` に追加:

```ts
  app.post('/api/knot/projects/:project/import', async (c) => {
    const onConflict = c.req.query('onConflict') ?? 'skip';
    if (onConflict !== 'skip' && onConflict !== 'overwrite') {
      return jsonError(c, 400, 'bad_request', { message: `invalid onConflict: ${onConflict}` });
    }
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    }
    try {
      const summary = await importCosense(storage, data, {
        projectName: c.req.param('project'), onConflict, now: now(),
      });
      return c.json(summary);
    } catch (e) {
      // クライアント不正（形式不正・不正なプロジェクト名など）だけを 400 にする。
      // SQL エラーや実装バグまで 400 に丸めない（rethrow して 5xx とログへ）。
      if (e instanceof StorageError || e instanceof InvalidExportError) {
        return jsonError(c, 400, 'bad_request', { message: e.message });
      }
      throw e;
    }
  });

  app.get('/api/knot/projects/:project/export', async (c) => {
    const format = c.req.query('format') ?? 'full';
    if (format !== 'full' && format !== 'import') {
      return jsonError(c, 400, 'bad_request', { message: `invalid format: ${format}` });
    }
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    return c.json(await exportCosense(storage, project.name, format, now()));
  });
```

`src/core/cosense.ts` の変更: `export class InvalidExportError extends Error`（`this.name = 'InvalidExportError'` を設定）を追加し、`parseExportFile` 内のすべての `throw new Error(...)` を `throw new InvalidExportError(...)` に置き換える。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/server test/server/import-export-api.test.ts
git commit -m "feat(server): インポート / エクスポート API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: 添付ファイル（アップロードと配信）

`POST /api/knot/files`（multipart）と `GET /files/:id/:filename?`。
サイズ上限、content-type のマジックバイト検査、sha256 再利用、ランダム化した保存名、nosniff、HTML/SVG の attachment 配信。

**Files:**
- Modify: `src/storage/types.ts`
- Modify: `src/storage/sqlite.ts`
- Create: `src/storage/migrations/0003_attachments_unique.sql`
- Create: `src/server/routes/files.ts`
- Modify: `src/server/app.ts`（`registerFileRoutes` の呼び出し追加）
- Test: `test/server/files-api.test.ts`

**Interfaces:**
- Consumes: attachments テーブル（0001_init.sql 作成済み）、`config.maxUploadBytes` / `config.dataDir`
- Produces:

```ts
// storage
export type Attachment = {
  id: string; projectId: string; filename: string; contentType: string;
  size: number; sha256: string; userId: string; created: number;
};
// interface Storage に追加:
  createAttachment(attachment: Attachment): Promise<void>;
  getAttachment(id: string): Promise<Attachment | null>;
  /** 再利用（dedup）はプロジェクト単位。別プロジェクトの ID / メタデータを漏らさない */
  findAttachmentBySha256(projectId: string, sha256: string): Promise<Attachment | null>;
```

`src/storage/migrations/0003_attachments_unique.sql`（並行アップロードの二重登録を DB 側で防ぐ）:

```sql
CREATE UNIQUE INDEX attachments_project_sha ON attachments(project_id, sha256);
```

```
POST /api/knot/files      multipart/form-data: file=<File>, project=<name>
200 { id, filename, contentType, size, sha256, url }   // url = /files/<id>/<encodeURIComponent(filename)>
200 既存の sha256 一致があればそのレコードを返す（ファイルを書き直さない）
400 file / project 欠落、プロジェクト不在、画像の content-type とマジックバイト不一致
413 { error: 'too_large' }   サイズ超過

GET /files/:id            （/files/:id/:filename も同じハンドラ。filename は無視）
200 ファイル内容。Content-Type は保存値、X-Content-Type-Options: nosniff（全応答共通）
    インライン許可リスト（下記）以外は Content-Disposition: attachment
404 レコードまたは実ファイル不在
```

- 保存先: `<dataDir>/files/<id>`（id は ULID。拡張子なし。ディレクトリはアップロード時に `mkdir recursive`）。
- 書き込みは `<id>.tmp` に書いてから rename → DB レコード挿入の順（DB 挿入失敗時は tmp/実ファイルを削除。UNIQUE 違反 = 並行アップロードなら既存レコードを引き直して返す）。孤立ファイルは無害（DB を参照して配信するため）だが残さない努力をする。
- `Content-Length` ヘッダが上限を超えていれば **multipart を解析する前に** 413（解析はボディ全体をメモリに載せるため、事後検査だけではメモリ枯渇対策にならない）。ヘッダがない・偽装されたケースは解析後のサイズ検査で拒否する（残余リスクはログイン必須のクローズド wiki として許容し、ストリーミング解析は将来課題）。
- マジックバイト検査: **インライン許可リストの型はすべて検査必須**。不一致は 400。リスト外の型は検査しない（attachment 配信で担保）。
  - `image/png` `89 50 4E 47` / `image/jpeg` `FF D8 FF` / `image/gif` `47 49 46 38` / `image/webp` `52 49 46 46 .. 57 45 42 50`
  - `video/mp4` offset 4 から `66 74 79 70`（ftyp）/ `video/webm` `1A 45 DF A3`（EBML）
  - `audio/mpeg` `49 44 33`（ID3）または先頭 11 ビットが 1（フレーム同期）/ `audio/ogg` `4F 67 67 53`（OggS）/ `audio/wav` `52 49 46 46 .. 57 41 56 45`
- インライン許可リスト: `image/png` `image/jpeg` `image/gif` `image/webp` `video/mp4` `video/webm` `audio/mpeg` `audio/ogg` `audio/wav`。これ以外（HTML、SVG、PDF、不明型を含む）は `Content-Disposition: attachment; filename*=UTF-8''<encodeURIComponent(filename)>`。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/files-api.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServer } from '../helpers/server.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup() {
  const s = await makeServer({ dataDir: mkdtempSync(join(tmpdir(), 'knot-files-')) });
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const upload = (bytes: Uint8Array, filename: string, type: string) => {
    const form = new FormData();
    form.append('file', new File([bytes], filename, { type }));
    form.append('project', 'proj');
    return s.request('/api/knot/files', { method: 'POST', body: form }, cookie);
  };
  return { s, cookie, upload };
}

test('PNG のアップロードと配信', async () => {
  const { s, cookie, upload } = await setup();
  const res = await upload(PNG, 'shot.png', 'image/png');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filename, 'shot.png');
  assert.equal(body.contentType, 'image/png');
  assert.equal(body.size, PNG.length);
  assert.equal(body.url, `/files/${body.id}/shot.png`);

  const got = await s.request(body.url, {}, cookie);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('content-disposition'), null); // インライン許可
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
});

test('同じ内容の再アップロードは既存レコードを返す', async () => {
  const { upload } = await setup();
  const first = await (await upload(PNG, 'a.png', 'image/png')).json();
  const second = await (await upload(PNG, 'b.png', 'image/png')).json();
  assert.equal(second.id, first.id);
  assert.equal(second.sha256, first.sha256);
});

test('インライン許可型の content-type とマジックバイト不一致は 400', async () => {
  const { upload } = await setup();
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  assert.equal((await upload(html, 'fake.png', 'image/png')).status, 400);
  assert.equal((await upload(html, 'fake.mp4', 'video/mp4')).status, 400);
  assert.equal((await upload(html, 'fake.mp3', 'audio/mpeg')).status, 400);
});

test('sha256 の再利用はプロジェクト単位（別プロジェクトには新レコード）', async () => {
  const { s, cookie, upload } = await setup();
  await s.storage.ensureProject('other', s.clock.t);
  const first = await (await upload(PNG, 'a.png', 'image/png')).json();
  const form = new FormData();
  form.append('file', new File([PNG], 'a.png', { type: 'image/png' }));
  form.append('project', 'other');
  const second = await (await s.request('/api/knot/files', { method: 'POST', body: form }, cookie)).json();
  assert.notEqual(second.id, first.id); // 別プロジェクトのレコード/ID を漏らさない
});

test('HTML と SVG は attachment で配信される', async () => {
  const { s, cookie, upload } = await setup();
  for (const [name, type, content] of [
    ['x.html', 'text/html', '<script>alert(1)</script>'],
    ['x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'],
  ] as const) {
    const body = await (await upload(new TextEncoder().encode(content), name, type)).json();
    const got = await s.request(body.url, {}, cookie);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('サイズ超過は 413', async () => {
  const { upload } = await setup();
  const big = new Uint8Array(11 * 1024 * 1024); // 既定上限 10MB
  big.set(PNG);
  const res = await upload(big, 'big.png', 'image/png');
  assert.equal(res.status, 413);
});

test('project 欠落・不在は 400、未認証の配信は 401', async () => {
  const { s, cookie, upload } = await setup();
  const form = new FormData();
  form.append('file', new File([PNG], 'x.png', { type: 'image/png' }));
  assert.equal((await s.request('/api/knot/files', { method: 'POST', body: form }, cookie)).status, 400);
  const body = await (await upload(PNG, 'x.png', 'image/png')).json();
  assert.equal((await s.app.request(body.url)).status, 401);
  assert.equal((await s.request('/files/01JUNKJUNKJUNKJUNKJUNKJUNK', {}, cookie)).status, 404);
});
```

`makeServer` に `overrides?: { dataDir?: string }` を足し、`defaultConfig(overrides?.dataDir ?? '/nonexistent')` で使う（既存テストは変更不要）。

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . npm test`
Expected: FAIL（storage メソッドとルートが未実装）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts`:

```ts
  async createAttachment(a: Attachment): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO attachments (id, project_id, filename, content_type, size, sha256, user_id, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.projectId, a.filename, a.contentType, a.size, a.sha256, a.userId, a.created);
  }

  #attachmentRowTo(a: {
    id: string; project_id: string; filename: string; content_type: string;
    size: number; sha256: string; user_id: string; created: number;
  }): Attachment {
    return {
      id: a.id, projectId: a.project_id, filename: a.filename, contentType: a.content_type,
      size: a.size, sha256: a.sha256, userId: a.user_id, created: a.created,
    };
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    const r = this.#db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
    return r ? this.#attachmentRowTo(r as never) : null;
  }

  async findAttachmentBySha256(projectId: string, sha256: string): Promise<Attachment | null> {
    const r = this.#db
      .prepare('SELECT * FROM attachments WHERE project_id = ? AND sha256 = ?')
      .get(projectId, sha256);
    return r ? this.#attachmentRowTo(r as never) : null;
  }
```

（`as never` の箇所は素直な行型 `AttachmentRow` を書いて使う。）

`src/server/routes/files.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { ulid } from '../../core/id.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, type ApiEnv } from '../http.ts';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// インライン配信を許可する型。この集合の型は必ず MAGIC 検査を通っている
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav',
]);

const startsWith = (b: Uint8Array, offset: number, bytes: number[]): boolean =>
  b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => startsWith(b, 0, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (b) => startsWith(b, 0, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => startsWith(b, 0, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (b) => startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x45, 0x42, 0x50]),
  'video/mp4': (b) => startsWith(b, 4, [0x66, 0x74, 0x79, 0x70]), // ....ftyp
  'video/webm': (b) => startsWith(b, 0, [0x1a, 0x45, 0xdf, 0xa3]), // EBML
  'audio/mpeg': (b) =>
    startsWith(b, 0, [0x49, 0x44, 0x33]) || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/ogg': (b) => startsWith(b, 0, [0x4f, 0x67, 0x67, 0x53]),
  'audio/wav': (b) => startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x41, 0x56, 0x45]),
};

export function registerFileRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const filesDir = join(config.dataDir, 'files');

  const attachmentToJson = (a: { id: string; filename: string; contentType: string; size: number; sha256: string }) => ({
    id: a.id, filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256,
    url: `/files/${a.id}/${encodeURIComponent(a.filename)}`,
  });

  app.post('/api/knot/files', async (c) => {
    // multipart の解析はボディ全体をメモリに載せるため、Content-Length で先に弾く
    // （multipart 境界のオーバーヘッド分に 64KB の余裕を持たせる）
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > config.maxUploadBytes + 64 * 1024) return jsonError(c, 413, 'too_large');

    const form = await c.req.parseBody();
    const file = form.file;
    const projectName = form.project;
    if (!(file instanceof File) || typeof projectName !== 'string') {
      return jsonError(c, 400, 'bad_request', { message: 'file and project required' });
    }
    const project = await storage.getProject(projectName);
    if (!project) return jsonError(c, 400, 'bad_request', { message: `unknown project: ${projectName}` });
    if (file.size > config.maxUploadBytes) return jsonError(c, 413, 'too_large');

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > config.maxUploadBytes) return jsonError(c, 413, 'too_large');
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    const check = MAGIC[contentType];
    if (check && !check(bytes)) {
      return jsonError(c, 400, 'bad_request', { message: `content does not match ${contentType}` });
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = await storage.findAttachmentBySha256(project.id, sha256);
    if (existing) return c.json(attachmentToJson(existing));

    const attachment = {
      id: ulid(now() * 1000), projectId: project.id, filename: file.name,
      contentType, size: bytes.length, sha256, userId: c.get('userId'), created: now(),
    };
    // tmp に書いて rename → DB 挿入。挿入失敗時はファイルを残さない。
    // UNIQUE (project_id, sha256) 違反は並行アップロードなので既存レコードを返す。
    await mkdir(filesDir, { recursive: true });
    const finalPath = join(filesDir, attachment.id);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, bytes);
    await rename(tmpPath, finalPath);
    try {
      await storage.createAttachment(attachment);
    } catch (e) {
      await rm(finalPath, { force: true });
      const raced = await storage.findAttachmentBySha256(project.id, sha256);
      if (raced) return c.json(attachmentToJson(raced));
      throw e;
    }
    return c.json(attachmentToJson(attachment));
  });

  const serveFile = async (c: Parameters<Parameters<typeof app.get>[1]>[0]): Promise<Response> => {
    const id = c.req.param('id');
    // 保存パスに使う ID は ULID 形式に限定する（path traversal と DB 内不正値への防御）
    if (!ULID_RE.test(id)) return jsonError(c, 404, 'not_found');
    const attachment = await storage.getAttachment(id);
    if (!attachment) return jsonError(c, 404, 'not_found');
    let bytes: Buffer;
    try {
      bytes = await readFile(join(filesDir, attachment.id));
    } catch {
      return jsonError(c, 404, 'not_found');
    }
    c.header('Content-Type', attachment.contentType);
    if (!INLINE_TYPES.has(attachment.contentType)) {
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    }
    return c.body(bytes);
  };

  app.get('/files/:id', serveFile);
  app.get('/files/:id/:filename', serveFile);
}
```

（`serveFile` の Context 型付けが煩雑なら `Context<ApiEnv>` を直接使う。）

`src/server/app.ts` に `registerFileRoutes(app, deps)` を追加。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/storage src/server test/server/files-api.test.ts test/helpers/server.ts
git commit -m "feat(server): 添付ファイルのアップロードと安全な配信

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: `knot serve` と設定ファイル

CLI から本物のサーバを起動する。config.json の読み込みテストと、spawn での起動スモーク 1 本。
**spawn スモークテストの実行はコントローラ側で行う**（Codex サンドボックスでは EPERM。plan-02 Task 10 と同じ扱い）。

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/cli/main.ts`
- Test: `test/server/config.test.ts`、`test/cli/serve.test.ts`

**Interfaces:**
- Consumes: `loadConfig`（Task 6）、`createApp`、`serve`（@hono/node-server）、`openDatabase` / `SqliteStorage`
- Produces: `runServe(dataDir: string, port: number, hostname: string): Promise<never>`（起動してログを出し、返らない）。CLI: `knot serve --data <dir> [--port <n>] [--hostname <s>]`（既定 port 3000、hostname 127.0.0.1）。

- [ ] **Step 1: config の失敗するテストを書く**

`test/server/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../../src/server/config.ts';

test('config.json が無ければ既定値', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  assert.deepEqual(loadConfig(dir), defaultConfig(dir));
});

test('config.json が既定値にマージされる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    secureCookie: false,
    allowedFrameHosts: ['www.youtube.com'],
    maxUploadBytes: 1024,
  }));
  const config = loadConfig(dir);
  assert.equal(config.secureCookie, false);
  assert.deepEqual(config.allowedFrameHosts, ['www.youtube.com']);
  assert.equal(config.maxUploadBytes, 1024);
  assert.deepEqual(config.allowedImageHosts, ['i.gyazo.com', 'gyazo.com']); // 未指定は既定のまま
});

test('未知キーはエラー', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ tyop: true }));
  assert.throws(() => loadConfig(dir), /unknown config key: tyop/);
});

test('型・範囲の不正な値はエラー', () => {
  for (const bad of [
    { maxUploadBytes: -1 },
    { sessionTtlSeconds: 'thirty days' },
    { secureCookie: 'yes' },
    { allowedImageHosts: ['ok.example', 42] },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'knot-config-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify(bad));
    assert.throws(() => loadConfig(dir), /invalid config value/);
  }
});
```

（`loadConfig` は Task 6 で実装済みのはずなので、このテストは書いた時点で通る可能性が高い。通ったらそれでよい — 回帰の固定が目的。）

- [ ] **Step 2: serve の失敗するテストを書く**

`test/cli/serve.test.ts`（起動スモーク。**コントローラ実行**）:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

test('knot serve が起動し、未認証 401 → ログイン → ページ作成まで通る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-serve-'));
  execFileSync(process.execPath, [mainPath, 'init', '--data', dir]);
  execFileSync(process.execPath, [mainPath, 'user', 'add', '--data', dir, '--name', 'alice'], {
    input: 'pw12345678',
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [mainPath, 'serve', '--data', dir, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // 起動を待つ（最大 10 秒、100ms ポーリング）
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ready = await fetch(`${base}/api/pages/none`).then((r) => r.status === 401).catch(() => false);
    }
    assert.ok(ready, 'server did not start');

    const login = await fetch(`${base}/api/knot/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke' },
      body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
    });
    assert.equal(login.status, 200);
    // loopback の http 起動では secureCookie: 'auto' が false に解決される
    assert.doesNotMatch(login.headers.get('set-cookie')!, /secure/i);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const put = await fetch(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    // プロジェクトは import 以外で作られない → 404。ensureProject の経路を通すため
    // まず import で空プロジェクトを作る…のではなく、期待を仕様として固定する:
    assert.equal(put.status, 404);

    const imp = await fetch(`${base}/api/knot/projects/proj/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ name: 'proj', displayName: 'proj', exported: 0, pages: [] }),
    });
    assert.equal(imp.status, 200);

    const put2 = await fetch(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    assert.equal(put2.status, 200);

    const text = await fetch(`${base}/api/pages/proj/Hello/text`, { headers: { Cookie: cookie } });
    assert.equal(await text.text(), 'Hello\nworld');
  } finally {
    child.kill();
  }
});
```

注: このスモークで「プロジェクトの新規作成手段が import しかない」ことが露呈する。これは仕様の穴なので、このタスクで **`POST /api/knot/projects/:project`（空プロジェクト作成、200 `{id, name, displayName}`、名前不正 400）** を write.ts に追加する。上のスモークの `imp` を `POST /api/knot/projects/proj`（body なし）に置き換え、`test/server/import-export-api.test.ts` にルートの単体テストを 1 本足す:

```ts
test('POST /api/knot/projects/:project で空プロジェクトを作れる', async () => {
  const { s, cookie } = await setup();
  const res = await s.request('/api/knot/projects/newproj', { method: 'POST' }, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'newproj');
  assert.equal((await s.request('/api/knot/projects/bad_NAME!', { method: 'POST' }, cookie)).status, 400);
  // 既存プロジェクトへの再 POST は冪等（ensureProject の意味論）
  assert.equal((await s.request('/api/knot/projects/newproj', { method: 'POST' }, cookie)).status, 200);
});
```

実装（write.ts）:

```ts
  app.post('/api/knot/projects/:project', async (c) => {
    try {
      const project = await storage.ensureProject(c.req.param('project'), now());
      return c.json({ id: project.id, name: project.name, displayName: project.displayName });
    } catch (e) {
      if (e instanceof StorageError) return jsonError(c, 400, 'bad_request', { message: e.message });
      throw e;
    }
  });
```

- [ ] **Step 3: 失敗を確認し、serve を実装する**

Run: `direnv exec . npm test` → FAIL（serve コマンドなし、プロジェクト作成ルートなし）

`src/cli/commands.ts` に追加:

```ts
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export async function runServe(dataDir: string, port: number, hostname: string): Promise<never> {
  const { serve } = await import('@hono/node-server');
  const { createApp } = await import('../server/app.ts');
  const { loadConfig } = await import('../server/config.ts');
  const config = loadConfig(dataDir);
  if (config.secureCookie === 'auto') {
    // http のローカル開発は Secure を外す（スペック「認証とセキュリティ」）。
    // loopback 以外で待ち受けるなら TLS 終端（プロキシ）前提として Secure を付ける。
    config.secureCookie = !LOOPBACK_HOSTS.has(hostname);
  }
  const storage = openStorage(dataDir); // 既存コマンド共通の DB オープン（knot.db が無ければ CliError で init を促す）
  const app = createApp({ storage, config });
  serve({ fetch: app.fetch, port, hostname });
  console.log(`knot serving http://${hostname}:${port}/ (data: ${dataDir})`);
  return new Promise<never>(() => {}); // serve はプロセスを保持する
}
```

（動的 import はサーバ関連の読み込みを serve 時に限るための素直な選択。トップレベル import でも動くならそれでよい。`openStorage` が「DB ファイルが無ければ CliError」になっていない場合はここで `existsSync(join(dataDir, 'knot.db'))` を検査して `knot init` を促すメッセージを出す。）

`src/cli/main.ts`: USAGE に serve 行を追加し、ディスパッチを足す:

```ts
    case 'serve': {
      if (positionals.length !== 0) throw new CliError(USAGE);
      const port = values.port === undefined ? 3000 : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(USAGE);
      return runServe(data, port, values.hostname ?? '127.0.0.1');
    }
```

parseArgs options に `port: { type: 'string' }`、`hostname: { type: 'string' }` を追加。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit`
Expected: 全テスト PASS（serve スモーク含む）、型エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/cli src/server test/cli/serve.test.ts test/server/config.test.ts test/server/import-export-api.test.ts
git commit -m "feat(cli): knot serve とプロジェクト作成 API を追加

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 完了条件

1. `direnv exec . npm test` が全テスト PASS（推定 160 本前後）、`direnv exec . npx tsc --noEmit` がエラーなし。
2. ロードマップの納品物「curl で登録から編集まで操作できる wiki API」の目視確認。実サーバで次の列が通ること:

```bash
DATA=$(mktemp -d)
node src/cli/main.ts init --data "$DATA"
echo -n 'pw12345678' | node src/cli/main.ts user add --data "$DATA" --name alice --admin
node src/cli/main.ts serve --data "$DATA" --port 3000 &

H='-H content-type:application/json -H X-Knot-Client:curl'
# ログイン（クッキー保存）
curl -s -c /tmp/knot-jar $H -d '{"name":"alice","password":"pw12345678"}' \
  -X POST http://127.0.0.1:3000/api/knot/session
# プロジェクト作成 → ページ作成（PUT text）→ 閲覧 → 検索 → タイトル変更 → エクスポート
curl -s -b /tmp/knot-jar $H -X POST http://127.0.0.1:3000/api/knot/projects/demo
curl -s -b /tmp/knot-jar $H -X PUT -d '{"baseVersion":0,"text":"Hello\nfirst [World] line"}' \
  http://127.0.0.1:3000/api/knot/pages/demo/Hello/text
curl -s -b /tmp/knot-jar http://127.0.0.1:3000/api/pages/demo
curl -s -b /tmp/knot-jar http://127.0.0.1:3000/api/pages/demo/Hello
curl -s -b /tmp/knot-jar 'http://127.0.0.1:3000/api/pages/demo/search/query?q=first'
curl -s -b /tmp/knot-jar $H -X POST -d '{"newTitle":"Hello World","rewriteLinks":true}' \
  http://127.0.0.1:3000/api/knot/pages/demo/Hello/rename
curl -s -b /tmp/knot-jar http://127.0.0.1:3000/api/knot/projects/demo/export
# 添付
curl -s -b /tmp/knot-jar -H X-Knot-Client:curl -F file=@<png ファイル> -F project=demo \
  http://127.0.0.1:3000/api/knot/files
```

3. plan-02 からの持ち越しが解消されていること: import の userId 再マップ（Task 1）、export users の commits 由来（Task 1）、プロジェクト displayName（Task 1）、409 title conflict の API payload（Task 10 で確定・文書化）。
4. plan-04 への持ち越しを進行台帳（`.superpowers/sdd/progress.md`）に記録する。少なくとも:
   - `sort=accessed` / `views` / テロメア（page_visits）は未追跡（04 で閲覧記録を書く）。
   - 検索はフレーズ検索のみ（複数語 AND なし）。search/query の `words` は形だけ。
   - HTML ルート（未ログイン時のログイン画面リダイレクト、404 の新規作成誘導画面）は 04 の管轄。
   - CSP の `script-src` / `style-src` は SSR (04) が要求を確定させてから調整。
   - 周辺ツール受け入れテスト（06）で読み取り API のフィールド互換を実測し、不足フィールドを補う。
   - レートリミットのクライアント IP はリバースプロキシ配下で正しく取れない（`X-Forwarded-For` の解釈とプロキシ信頼設定は 06 の運用ドキュメントと合わせて設計）。取得不能時は全クライアント共有キー 'local' に落ちる。
   - アップロードの multipart はメモリ上で解析する（Content-Length の事前検査でメモリ枯渇を緩和。ストリーミング解析は将来課題）。
