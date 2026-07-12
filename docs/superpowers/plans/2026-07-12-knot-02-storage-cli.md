# knot 02: storage-cli 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQLite ストレージ（マイグレーション、コミットのトランザクション、409/400/冪等性、導出データ更新、検索、reindex）とインポート/エクスポート、CLI（init / import / export / reindex）を TDD で実装し、Cosense エクスポート JSON の round-trip を通す。

**Architecture:** `src/storage/` に async な `Storage` インターフェース（将来の Workers/D1 差し替え点）と node:sqlite 実装を置く。
書き込みはすべて「コミット」として commits テーブルに残す（インポートも同様。スペックの不変条件）。
links / pages_fts / pages.image は lines から再構築できる導出データで、コミット適用時に更新し、reindex で作り直せる。
CLI は `src/cli/` の薄い argv ディスパッチで、ロジックは storage 層の関数を呼ぶだけにする。

**Tech Stack:** TypeScript（Node 24 type stripping、ビルドなし）、node:sqlite（SQLite 3.53.1、FTS5 trigram — このマシンで実測確認済み）、node:test、node:crypto（SHA-256）。

**Spec:** `docs/superpowers/specs/2026-07-10-knot-design.md`（「データモデル」「Cosense 互換性 > インポートとエクスポート」「リンクとタグ」「エラー処理」「テスト戦略」の各節）
**Roadmap:** `docs/superpowers/plans/2026-07-11-knot-roadmap.md`（この計画は 02。01 core は main にマージ済み）

## Global Constraints

- Node.js >= 24（node:sqlite と type stripping の前提）。
- 実行時依存は `@progfay/scrapbox-parser@10.1.1` のみで、本計画では依存を追加しない。DB は node:sqlite、ハッシュは node:crypto。
- テストランナーは node:test、アサーションは node:assert/strict。`npm test` で全テストが走ること。
- import 指定子は `.ts` 拡張子付きで書く（type stripping の要件）。
- tsconfig は `erasableSyntaxOnly: true`。enum・namespace・constructor の parameter properties は書けない。
- タイムスタンプはすべて Unix 秒の整数。ID は ULID（インポート時は Cosense の 24 桁 hex ID をそのまま保持）。`ulid()` の引数はミリ秒なので、Unix 秒 `now` から発行するときは `ulid(now * 1000)` とする。
- node:sqlite の `get()` / `all()` は null プロトタイプのオブジェクトを返す。テストで DB 行に直接 `assert.deepEqual` を使わない（storage 層で plain object に詰め替えたものには使ってよい）。
- FTS5 の `MATCH` はテーブル別名を受け付けない（実測）。JOIN では別名を付けず `pages_fts MATCH ?` と書く。
- コミットメッセージは日本語で、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` を付ける。
- 各タスクの最後に `npm test` と `npx tsc --noEmit` が両方成功していること。

## スコープ外（後続計画でやる）

- HTTP API・認証・添付アップロード（03 api-server）。sessions / attachments / page_visits テーブルはスキーマだけ作り、本計画では読み書きしない。
- relatedPages / 2-hop リンクの読み取りクエリ（03 が links テーブルの上に実装する）。
- `knot export --with-files`（zip 同梱）、定期エクスポート、バックアップ/復元（06 ops-compat）。
- `PUT .../text` の LCS 経路（core の `diffLines` は実装済み。サーバ経路は 03）。

## ファイル構成

| ファイル | 責務 |
| --- | --- |
| `src/storage/db.ts` | DB オープン（WAL、外部キー）と連番 SQL マイグレーションの適用 |
| `src/storage/migrations/0001_init.sql` | 全テーブルのスキーマ（スペック「スキーマ」節の写し） |
| `src/storage/types.ts` | `Storage` インターフェース、DTO 型、エラー型 |
| `src/storage/sqlite.ts` | `SqliteStorage`（コミット、検索、reindex、importPage） |
| `src/storage/hash.ts` | 冪等性判定用の正規化ハッシュ `opsHash` |
| `src/storage/import.ts` | Cosense エクスポート JSON → importPage の列に変換する `importCosense` |
| `src/storage/export.ts` | ページ列 → Cosense エクスポート JSON の `exportCosense` |
| `src/cli/commands.ts` | 各コマンドの実体（テスト対象） |
| `src/cli/main.ts` | shebang + parseArgs のディスパッチのみ（テストは spawn 1 本） |
| `test/helpers/storage.ts` | `:memory:` DB と SqliteStorage を作るテストヘルパ |
| `test/fixtures/cosense-export.json` | round-trip 用の Cosense 形式フィクスチャ |

---

### Task 0: plan-01 持ち越し Minor の解消

plan-01 の最終レビューで triage した持ち越し（`.superpowers/sdd/progress.md` 記載）を先に片付ける。
対象は (1) `parseExportFile` のメタデータ型検査、(2) object 検証 throw の理由サフィックス、(3) 返り値の防御的コピー、(4) ops.test の共有テストブロック分割、の 4 点。

**Files:**
- Modify: `src/core/cosense.ts`
- Modify: `test/core/cosense.test.ts`
- Modify: `test/core/ops.test.ts`

**Interfaces:**
- Consumes: `parseExportFile(data: unknown): CosenseExport`（core、実装済み）
- Produces: 同シグネチャのまま検証を強化した `parseExportFile`。Task 8 のインポートはこれを入力境界の検証として使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/core/cosense.test.ts` の末尾に追加:

```ts
test('行メタデータの型不正を拒否する', () => {
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', created: '10' }] }] }),
    /pages\[0\].*created/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', updated: '20' }] }] }),
    /pages\[0\].*updated/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', id: 123 }] }] }),
    /pages\[0\].*id/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', userId: 5 }] }] }),
    /pages\[0\].*userId/,
  );
});

test('ページメタデータの型不正を拒否する', () => {
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', created: 'x', lines: ['p'] }] }),
    /pages\[0\]\.created/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', id: 9, lines: ['p'] }] }),
    /pages\[0\]\.id/,
  );
});

test('users の要素に id と name が必須', () => {
  assert.throws(
    () => parseExportFile({ users: [{ name: 'alice' }], pages: [{ title: 'p', lines: ['p'] }] }),
    /users\[0\]/,
  );
});

test('ページでない要素は位置と理由つきで拒否する', () => {
  assert.throws(() => parseExportFile({ pages: ['x'] }), /pages\[0\] must be an object/);
});

test('返り値は入力から独立したコピーである', () => {
  const data = { pages: [{ title: 'p', lines: ['p'] }] };
  const out = parseExportFile(data);
  out.pages[0].title = 'changed';
  assert.equal(data.pages[0].title, 'p');
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（追加した 5 テストが落ちる。既存テストは通ったまま）

- [ ] **Step 3: 実装する**

`src/core/cosense.ts` の `parseExportFile` を次で置き換え、直前にヘルパを追加する:

```ts
function checkOptional(value: unknown, type: 'number' | 'string', where: string): void {
  if (value !== undefined && typeof value !== type) {
    throw new Error(`invalid export: ${where} must be a ${type}`);
  }
}

export function parseExportFile(data: unknown): CosenseExport {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { pages?: unknown }).pages)) {
    throw new Error('invalid export: pages array is required');
  }
  const raw = data as CosenseExport;
  (raw.users ?? []).forEach((user, i) => {
    if (typeof user !== 'object' || user === null || typeof user.id !== 'string' || typeof user.name !== 'string') {
      throw new Error(`invalid export: users[${i}] must have id and name`);
    }
  });
  raw.pages.forEach((page, i) => {
    if (typeof page !== 'object' || page === null) {
      throw new Error(`invalid export: pages[${i}] must be an object`);
    }
    if (typeof page.title !== 'string' || page.title === '') {
      throw new Error(`invalid export: pages[${i}].title is required`);
    }
    checkOptional(page.id, 'string', `pages[${i}].id`);
    checkOptional(page.created, 'number', `pages[${i}].created`);
    checkOptional(page.updated, 'number', `pages[${i}].updated`);
    if (!Array.isArray(page.lines) || page.lines.length === 0) {
      throw new Error(`invalid export: pages[${i}].lines must be a non-empty array`);
    }
    page.lines.forEach((line, j) => {
      if (typeof line === 'string') return;
      if (typeof line !== 'object' || line === null || typeof line.text !== 'string') {
        throw new Error(`invalid export: pages[${i}].lines[${j}] must be a string or an object with text`);
      }
      checkOptional(line.id, 'string', `pages[${i}].lines[${j}].id`);
      checkOptional(line.created, 'number', `pages[${i}].lines[${j}].created`);
      checkOptional(line.updated, 'number', `pages[${i}].lines[${j}].updated`);
      checkOptional(line.userId, 'string', `pages[${i}].lines[${j}].userId`);
    });
  });
  return structuredClone(raw);
}
```

`structuredClone` のコピーコストは、インポートが一括の CLI 操作なので許容する（設計判断）。

- [ ] **Step 4: ops.test の共有テストブロックを分割する**

`test/core/ops.test.ts` の次のテスト:

```ts
test('存在しない行への update / delete は OpsError', () => {
  assert.throws(() => validateOps([line('a')], [{ type: 'update', id: 'zz', text: 't' }]), OpsError);
  assert.throws(() => validateOps([line('a')], [{ type: 'delete', id: 'zz' }]), OpsError);
});
```

を次の 2 テストに置き換える:

```ts
test('存在しない行への update は OpsError', () => {
  assert.throws(() => validateOps([line('a')], [{ type: 'update', id: 'zz', text: 't' }]), OpsError);
});

test('存在しない行への delete は OpsError', () => {
  assert.throws(() => validateOps([line('a')], [{ type: 'delete', id: 'zz' }]), OpsError);
});
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 6: Commit**

```bash
git add src/core/cosense.ts test/core/cosense.test.ts test/core/ops.test.ts
git commit -m "fix(core): plan-01 持ち越しの parseExportFile 型検査・防御的コピーと ops テスト分割"
```

---

### Task 1: DB オープンとマイグレーション

**Files:**
- Create: `src/storage/db.ts`
- Create: `src/storage/migrations/0001_init.sql`
- Test: `test/storage/db.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `openDatabase(path: string): DatabaseSync` — WAL・外部キー設定と未適用マイグレーションの適用込みで DB を開く。`migrate(db: DatabaseSync): void`。以降の全タスクが `openDatabase(':memory:')` でテスト用 DB を作る。

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/storage/db.ts';

test('マイグレーションで全テーブルが作られ user_version が進む', () => {
  const db = openDatabase(':memory:');
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const expected = [
    'projects', 'users', 'pages', 'lines', 'commits', 'title_history',
    'page_visits', 'links', 'attachments', 'sessions', 'pages_fts',
  ];
  for (const t of expected) assert.ok(names.includes(t), `${t} がない`);
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 1);
  db.close();
});

test('再オープンしても適用済みマイグレーションを二重適用しない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-'));
  const path = join(dir, 'knot.db');
  openDatabase(path).close();
  const db = openDatabase(path);
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 1);
  db.close();
});

test('FTS5 trigram が動く（3 文字はヒット、2 文字は 0 件）', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)').run(
    'p1', 'pr', 'knot 設計書',
  );
  const q = db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?');
  assert.equal(q.all('"設計書"').length, 1);
  assert.equal(q.all('"設計"').length, 0);
  db.close();
});

test('title_lc の一意性は削除済みページに適用されない', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO projects (id, name, display_name, created, updated) VALUES ('p', 'p', 'p', 0, 0)").run();
  const ins = db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES (?, 'p', 'T', 't', 1, 0, ?, NULL, 0, 0)`,
  );
  ins.run('a', 1);
  ins.run('b', 0);
  assert.throws(() => ins.run('c', 0), /UNIQUE/);
  db.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/storage/db.ts`）

- [ ] **Step 3: スキーマとローダを実装する**

`src/storage/migrations/0001_init.sql`（スペック「スキーマ」節の写し。全テーブルをここで作る）:

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  title_lc TEXT NOT NULL,
  version INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX pages_title_lc ON pages(project_id, title_lc) WHERE deleted = 0;

CREATE TABLE lines (
  id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  updated_version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (page_id, id)
);
CREATE INDEX lines_page_ord ON lines(page_id, ord);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  base_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  ops TEXT NOT NULL,
  ops_hash TEXT NOT NULL,
  UNIQUE (page_id, version)
);

CREATE TABLE title_history (
  page_id TEXT NOT NULL REFERENCES pages(id),
  old_title TEXT NOT NULL,
  old_title_lc TEXT NOT NULL,
  started INTEGER NOT NULL,
  ended INTEGER NOT NULL
);

CREATE TABLE page_visits (
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  visited INTEGER NOT NULL,
  last_seen_version INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE links (
  project_id TEXT NOT NULL,
  source_page_id TEXT NOT NULL,
  target_title_lc TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_title_lc)
);
CREATE INDEX links_target ON links(project_id, target_title_lc);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  page_id UNINDEXED,
  project_id UNINDEXED,
  content,
  tokenize='trigram'
);
```

`src/storage/db.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function migrate(db: DatabaseSync): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const file of files) {
    const n = Number(file.slice(0, 4));
    if (n <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.exec(`PRAGMA user_version = ${n}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
```

`PRAGMA user_version` はトランザクション内で設定でき、ロールバックで戻る（SQLite の仕様）。
`journal_mode = WAL` は `:memory:` では no-op。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/db.ts src/storage/migrations/0001_init.sql test/storage/db.test.ts
git commit -m "feat(storage): スキーマとマイグレーションローダを追加"
```

---

### Task 2: Storage インターフェースと基本操作

`Storage` インターフェースは**この時点で全メソッドを確定**させ、未実装分は `not implemented` を投げるスタブとして置く。
後続タスクはスタブを 1 つずつ本実装に置き換える（インターフェースの形はもう変えない）。

**Files:**
- Create: `src/storage/types.ts`
- Create: `src/storage/sqlite.ts`
- Create: `test/helpers/storage.ts`
- Test: `test/storage/storage.test.ts`

**Interfaces:**
- Consumes: `openDatabase`（Task 1）、`ulid`（core）、`Line` / `LineOp`（core）
- Produces: `Storage` インターフェース全体と DTO 型（下記 types.ts が正）。本タスクで実装するのは `ensureProject` / `getProject` / `upsertDisplayUser` / `listUsersForProject` / `getPageByTitle` / `getPageById` / `listPages` / `close`。`commit` / `importPage` / `search` / `reindex` はスタブ。
- テストヘルパ `makeStorage(): { db: DatabaseSync; storage: SqliteStorage }`（`:memory:`）。

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/storage.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { StorageError } from '../../src/storage/types.ts';

test('ensureProject は無ければ作り、あれば同じものを返す', async () => {
  const { storage } = makeStorage();
  const a = await storage.ensureProject('wiki', 100);
  const b = await storage.ensureProject('wiki', 200);
  assert.equal(a.id, b.id);
  assert.equal(b.created, 100);
  assert.equal(await storage.getProject('nope'), null);
  await storage.close();
});

test('不正・予約語のプロジェクト名を拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(storage.ensureProject('Bad Name', 1), StorageError);
  await assert.rejects(storage.ensureProject('api', 1), StorageError);
  await storage.close();
});

test('upsertDisplayUser は name 一致の既存ユーザー ID を返す', async () => {
  const { db, storage } = makeStorage();
  const first = await storage.upsertDisplayUser({ id: 'u1', name: 'alice', displayName: 'Alice' }, 1);
  const second = await storage.upsertDisplayUser({ id: 'u2', name: 'alice', displayName: 'Alice2' }, 2);
  assert.equal(first, 'u1');
  assert.equal(second, 'u1');
  const count = (db.prepare('SELECT count(*) AS c FROM users').get() as { c: number }).c;
  assert.equal(count, 1);
  await storage.close();
});

test('getPageByTitle / listPages は削除済みページを除外する', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 100);
  const insertPage = db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES (?, ?, ?, ?, 1, 0, ?, NULL, 10, ?)`,
  );
  insertPage.run('pg1', project.id, 'Foo Bar', 'foo_bar', 0, 30);
  insertPage.run('pg2', project.id, 'Gone', 'gone', 1, 20);
  db.prepare(
    `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
     VALUES ('l1', 'pg1', 0, 'Foo Bar', 10, 10, 1, 'u1'), ('l2', 'pg1', 1, 'body', 10, 12, 1, 'u1')`,
  ).run();

  const page = await storage.getPageByTitle(project.id, 'foo_bar');
  assert.ok(page);
  assert.equal(page.title, 'Foo Bar');
  assert.deepEqual(
    page.lines.map((l) => ({ id: l.id, text: l.text, updatedVersion: l.updatedVersion })),
    [
      { id: 'l1', text: 'Foo Bar', updatedVersion: 1 },
      { id: 'l2', text: 'body', updatedVersion: 1 },
    ],
  );
  assert.equal(await storage.getPageByTitle(project.id, 'gone'), null);

  const list = await storage.listPages(project.id);
  assert.deepEqual(list.map((p) => p.id), ['pg1']);

  const byId = await storage.getPageById('pg2');
  assert.ok(byId);
  assert.equal(byId.deleted, true);
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../test/helpers/storage.ts`）

- [ ] **Step 3: 型・実装・ヘルパを書く**

`src/storage/types.ts`:

```ts
import type { Line, LineOp } from '../core/ops.ts';

export type Project = {
  id: string;
  name: string;
  displayName: string;
  created: number;
  updated: number;
};

export type DisplayUser = { id: string; name: string; displayName: string };

export type PageMeta = {
  id: string;
  projectId: string;
  title: string;
  titleLc: string;
  version: number;
  pinned: number;
  deleted: boolean;
  image: string | null;
  created: number;
  updated: number;
};

export type PageSnapshot = PageMeta & { lines: Line[] };

export type CommitInput = {
  projectId: string;
  pageId: string;
  commitId: string;
  baseVersion: number;
  ops: LineOp[];
  userId: string;
  now: number;
};

export type CommitResult =
  | { kind: 'applied'; version: number }
  | { kind: 'conflict'; reason: 'version' | 'title'; page: PageSnapshot };

export type ImportLine = { id: string; text: string; created: number; updated: number; userId: string };

export type ImportPageInput = {
  projectId: string;
  page: { id: string; title: string; created: number; updated: number };
  lines: ImportLine[];
  userId: string;
  now: number;
  onConflict: 'skip' | 'overwrite';
};

export type ImportPageResult = { kind: 'created' | 'overwritten' | 'skipped'; pageId: string };

export type SearchHit = { pageId: string; title: string; lines: string[] };

/** 400 系: 再送しても直らないクライアント不正。409（conflict）とは区別する。 */
export class BadCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadCommitError';
  }
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface Storage {
  ensureProject(name: string, now: number): Promise<Project>;
  getProject(name: string): Promise<Project | null>;
  /** name 一致の既存ユーザーがいればそれを優先し、実際に有効なユーザー ID を返す。 */
  upsertDisplayUser(user: DisplayUser, now: number): Promise<string>;
  listUsersForProject(projectId: string): Promise<DisplayUser[]>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  listPages(projectId: string): Promise<PageMeta[]>;
  commit(input: CommitInput): Promise<CommitResult>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
  search(projectId: string, query: string): Promise<SearchHit[]>;
  reindex(projectId?: string): Promise<{ pages: number }>;
  close(): Promise<void>;
}
```

`src/storage/sqlite.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import type { Line } from '../core/ops.ts';
import { ulid } from '../core/id.ts';
import {
  StorageError,
  type CommitInput,
  type CommitResult,
  type DisplayUser,
  type ImportPageInput,
  type ImportPageResult,
  type PageMeta,
  type PageSnapshot,
  type Project,
  type SearchHit,
  type Storage,
} from './types.ts';

const PROJECT_NAME_RE = /^[a-z0-9-]+$/;
const RESERVED_PROJECT_NAMES = new Set(['api', 'login', 'files', 'assets']);

type PageRow = {
  id: string;
  project_id: string;
  title: string;
  title_lc: string;
  version: number;
  pinned: number;
  deleted: number;
  image: string | null;
  created: number;
  updated: number;
};

type LineRow = {
  id: string;
  text: string;
  created: number;
  updated: number;
  updated_version: number;
  user_id: string;
};

export class SqliteStorage implements Storage {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #getProjectRow(name: string): Project | null {
    const r = this.#db
      .prepare('SELECT id, name, display_name, created, updated FROM projects WHERE name = ?')
      .get(name) as { id: string; name: string; display_name: string; created: number; updated: number } | undefined;
    return r ? { id: r.id, name: r.name, displayName: r.display_name, created: r.created, updated: r.updated } : null;
  }

  async ensureProject(name: string, now: number): Promise<Project> {
    if (!PROJECT_NAME_RE.test(name) || RESERVED_PROJECT_NAMES.has(name)) {
      throw new StorageError(`invalid project name: ${name}`);
    }
    return this.#tx(() => {
      const existing = this.#getProjectRow(name);
      if (existing) return existing;
      const id = ulid(now * 1000);
      this.#db
        .prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, name, now, now);
      return { id, name, displayName: name, created: now, updated: now };
    });
  }

  async getProject(name: string): Promise<Project | null> {
    return this.#getProjectRow(name);
  }

  async upsertDisplayUser(user: DisplayUser, now: number): Promise<string> {
    this.#db
      .prepare('INSERT OR IGNORE INTO users (id, name, display_name, created) VALUES (?, ?, ?, ?)')
      .run(user.id, user.name, user.displayName, now);
    const row = this.#db.prepare('SELECT id FROM users WHERE name = ?').get(user.name) as
      | { id: string }
      | undefined;
    return row ? row.id : user.id;
  }

  async listUsersForProject(projectId: string): Promise<DisplayUser[]> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT u.id, u.name, u.display_name FROM users u
         JOIN lines l ON l.user_id = u.id
         JOIN pages p ON p.id = l.page_id
         WHERE p.project_id = ?
         ORDER BY u.name`,
      )
      .all(projectId) as { id: string; name: string; display_name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name }));
  }

  #pageRowToMeta(r: PageRow): PageMeta {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      titleLc: r.title_lc,
      version: r.version,
      pinned: r.pinned,
      deleted: r.deleted === 1,
      image: r.image,
      created: r.created,
      updated: r.updated,
    };
  }

  #getLines(pageId: string): Line[] {
    const rows = this.#db
      .prepare('SELECT id, text, created, updated, updated_version, user_id FROM lines WHERE page_id = ? ORDER BY ord')
      .all(pageId) as LineRow[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      created: r.created,
      updated: r.updated,
      updatedVersion: r.updated_version,
      userId: r.user_id,
    }));
  }

  #snapshot(row: PageRow): PageSnapshot {
    return { ...this.#pageRowToMeta(row), lines: this.#getLines(row.id) };
  }

  async getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null> {
    const row = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
      .get(projectId, titleLcValue) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async getPageById(pageId: string): Promise<PageSnapshot | null> {
    const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async listPages(projectId: string): Promise<PageMeta[]> {
    const rows = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id')
      .all(projectId) as PageRow[];
    return rows.map((r) => this.#pageRowToMeta(r));
  }

  async commit(_input: CommitInput): Promise<CommitResult> {
    throw new Error('not implemented: commit (Task 3)');
  }

  async importPage(_input: ImportPageInput): Promise<ImportPageResult> {
    throw new Error('not implemented: importPage (Task 8)');
  }

  async search(_projectId: string, _query: string): Promise<SearchHit[]> {
    throw new Error('not implemented: search (Task 6)');
  }

  async reindex(_projectId?: string): Promise<{ pages: number }> {
    throw new Error('not implemented: reindex (Task 7)');
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
```

`test/helpers/storage.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';

export function makeStorage(): { db: DatabaseSync; storage: SqliteStorage } {
  const db = openDatabase(':memory:');
  return { db, storage: new SqliteStorage(db) };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/types.ts src/storage/sqlite.ts test/helpers/storage.ts test/storage/storage.test.ts
git commit -m "feat(storage): Storage インターフェースと基本操作を追加"
```

---

### Task 3: コミットのトランザクション（適用・409・400）

コミットエンジンの中核。
仕様（スペック「行操作とコミット」節）: baseVersion 一致時のみ単一トランザクションで適用し version を +1、不一致は 409 相当（最新スナップショット同梱）、不正 ops は 400 相当で全体ロールバック。
先頭行のテキスト変化はタイトル変更として扱い、title_lc 一意制約違反はコミット全体を 409 で拒否。
全行 delete はページ削除（`pages.deleted` を立て、commits は保持）。
削除済みページへのコミットは 400 相当で拒否する（削除後の同タイトル再作成は新しい page_id で行う、というスペックの規則に対応する設計判断）。

**Files:**
- Create: `src/storage/hash.ts`
- Modify: `src/storage/sqlite.ts`（`commit` スタブを本実装に置き換え）
- Test: `test/storage/commit.test.ts`

**Interfaces:**
- Consumes: `applyOps` / `OpsError`（core）、`titleLc`（core）、`opsHash`（本タスクで作成）
- Produces: `commit(input: CommitInput): Promise<CommitResult>`（本実装）、`opsHash(pageId: string, baseVersion: number, ops: LineOp[]): string`、private `#insertCommit(commitId, pageId, baseVersion, version, userId, now, ops)`（Task 8 の importPage が再利用する）

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/commit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { BadCommitError } from '../../src/storage/types.ts';
import { opsHash } from '../../src/storage/hash.ts';
import type { LineOp } from '../../src/core/ops.ts';

test('opsHash はキー順に依存しない決定的ハッシュ', () => {
  const a: LineOp[] = [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }];
  const reordered = [{ after: '_head', text: 'T', type: 'insert', id: 'l1' }] as LineOp[];
  assert.equal(opsHash('p', 0, a), opsHash('p', 0, reordered));
  assert.notEqual(opsHash('p', 0, a), opsHash('p', 1, a));
});

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  return { db, storage, project };
}

test('最初のコミットでページが作られ version 1 になる', async () => {
  const { storage, project } = await setup();
  const r = await storage.commit({
    projectId: project.id,
    pageId: 'pg1',
    commitId: 'c1',
    baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'タイトル' }],
    userId: 'u1',
    now: 2000,
  });
  assert.deepEqual(r, { kind: 'applied', version: 1 });
  const page = await storage.getPageByTitle(project.id, 'タイトル');
  assert.ok(page);
  assert.equal(page.version, 1);
  assert.equal(page.title, 'タイトル');
  assert.deepEqual(page.lines.map((l) => l.text), ['タイトル']);
  assert.equal(page.lines[0].updatedVersion, 1);
  await storage.close();
});

test('逐次コミットで version が増え、行順と ord が ops 適用順に決まる', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1', now: 2000,
  });
  const r = await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [
      { type: 'insert', id: 'l2', after: 'l1', text: 'a' },
      { type: 'insert', id: 'l3', after: 'l2', text: 'b' },
    ],
    userId: 'u2', now: 3000,
  });
  assert.deepEqual(r, { kind: 'applied', version: 2 });
  const page = await storage.getPageByTitle(project.id, 't');
  assert.ok(page);
  assert.deepEqual(page.lines.map((l) => l.text), ['T', 'a', 'b']);
  assert.deepEqual(page.lines.map((l) => l.userId), ['u1', 'u2', 'u2']);
  const ords = (db.prepare('SELECT ord FROM lines WHERE page_id = ? ORDER BY ord').all('pg1') as { ord: number }[])
    .map((r2) => r2.ord);
  assert.deepEqual(ords, [0, 1, 2]);
  await storage.close();
});

test('先頭行の変更はタイトル変更になり title_history に残る', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'Old Title' }],
    userId: 'u1', now: 2000,
  });
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'update', id: 'l1', text: 'New Title' }],
    userId: 'u1', now: 3000,
  });
  assert.equal(await storage.getPageByTitle(project.id, 'old_title'), null);
  const page = await storage.getPageByTitle(project.id, 'new_title');
  assert.ok(page);
  assert.equal(page.title, 'New Title');
  const hist = db
    .prepare('SELECT old_title, old_title_lc, started, ended FROM title_history WHERE page_id = ?')
    .all('pg1') as { old_title: string; old_title_lc: string; started: number; ended: number }[];
  assert.equal(hist.length, 1);
  assert.equal(hist[0].old_title, 'Old Title');
  assert.equal(hist[0].old_title_lc, 'old_title');
  assert.equal(hist[0].ended, 3000);
  await storage.close();
});

test('_head への insert による先頭行の入れ替えもタイトル変更になる', async () => {
  const { storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'A' }],
    userId: 'u1', now: 2000,
  });
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'insert', id: 'l0', after: '_head', text: 'B' }],
    userId: 'u1', now: 3000,
  });
  const page = await storage.getPageByTitle(project.id, 'b');
  assert.ok(page);
  assert.deepEqual(page.lines.map((l) => l.text), ['B', 'A']);
  await storage.close();
});

test('全行 delete でページが削除され、commits は残る', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1', now: 2000,
  });
  const r = await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'delete', id: 'l1' }],
    userId: 'u1', now: 3000,
  });
  assert.deepEqual(r, { kind: 'applied', version: 2 });
  assert.equal(await storage.getPageByTitle(project.id, 't'), null);
  const row = db.prepare('SELECT deleted, title FROM pages WHERE id = ?').get('pg1') as {
    deleted: number; title: string;
  };
  assert.equal(row.deleted, 1);
  assert.equal(row.title, 'T');
  const commits = (db.prepare('SELECT count(*) AS c FROM commits WHERE page_id = ?').get('pg1') as { c: number }).c;
  assert.equal(commits, 2);
  await storage.close();
});

test('baseVersion 不一致は conflict と最新スナップショットを返す', async () => {
  const { storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1', now: 2000,
  });
  const r = await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l2', after: 'l1', text: 'x' }],
    userId: 'u2', now: 3000,
  });
  assert.equal(r.kind, 'conflict');
  if (r.kind !== 'conflict') return;
  assert.equal(r.reason, 'version');
  assert.equal(r.page.version, 1);
  assert.deepEqual(r.page.lines.map((l) => l.text), ['T']);
  await storage.close();
});

test('タイトルの一意制約違反はコミット全体が conflict になる', async () => {
  const { storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pgA', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'a1', after: '_head', text: 'Foo' }],
    userId: 'u1', now: 2000,
  });
  await storage.commit({
    projectId: project.id, pageId: 'pgB', commitId: 'c2', baseVersion: 0,
    ops: [
      { type: 'insert', id: 'b1', after: '_head', text: 'Bar' },
      { type: 'insert', id: 'b2', after: 'b1', text: 'body' },
    ],
    userId: 'u1', now: 3000,
  });
  // 先頭行を 'foo' に変えると pgA と title_lc が衝突する
  const r = await storage.commit({
    projectId: project.id, pageId: 'pgB', commitId: 'c3', baseVersion: 1,
    ops: [{ type: 'update', id: 'b1', text: 'foo' }],
    userId: 'u1', now: 4000,
  });
  assert.equal(r.kind, 'conflict');
  if (r.kind !== 'conflict') return;
  assert.equal(r.reason, 'title');
  assert.equal(r.page.id, 'pgA');
  // pgB は変わっていない（ロールバック相当）
  const pgB = await storage.getPageByTitle(project.id, 'bar');
  assert.ok(pgB);
  assert.equal(pgB.version, 1);
  assert.deepEqual(pgB.lines.map((l) => l.text), ['Bar', 'body']);
  // 新規作成の同タイトル衝突も conflict
  const r2 = await storage.commit({
    projectId: project.id, pageId: 'pgC', commitId: 'c4', baseVersion: 0,
    ops: [{ type: 'insert', id: 'c1x', after: '_head', text: 'FOO' }],
    userId: 'u1', now: 5000,
  });
  assert.equal(r2.kind, 'conflict');
  await storage.close();
});

test('不正 ops は BadCommitError で、コミット全体がロールバックされる', async () => {
  const { storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1', now: 2000,
  });
  await assert.rejects(
    storage.commit({
      projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
      ops: [
        { type: 'update', id: 'l1', text: 'changed' },
        { type: 'delete', id: 'missing' },
      ],
      userId: 'u1', now: 3000,
    }),
    BadCommitError,
  );
  const page = await storage.getPageByTitle(project.id, 't');
  assert.ok(page);
  assert.equal(page.version, 1);
  assert.deepEqual(page.lines.map((l) => l.text), ['T']);
  // 空の ops も 400 系
  await assert.rejects(
    storage.commit({
      projectId: project.id, pageId: 'pg1', commitId: 'c3', baseVersion: 1,
      ops: [], userId: 'u1', now: 3000,
    }),
    BadCommitError,
  );
  await storage.close();
});

test('存在しないページ・別プロジェクトのページ・削除済みページへのコミットは BadCommitError', async () => {
  const { storage, project } = await setup();
  await assert.rejects(
    storage.commit({
      projectId: project.id, pageId: 'nope', commitId: 'c1', baseVersion: 5,
      ops: [{ type: 'update', id: 'l1', text: 'x' }], userId: 'u1', now: 2000,
    }),
    BadCommitError,
  );
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1', now: 2000,
  });
  const other = await storage.ensureProject('other', 1000);
  await assert.rejects(
    storage.commit({
      projectId: other.id, pageId: 'pg1', commitId: 'c3', baseVersion: 1,
      ops: [{ type: 'update', id: 'l1', text: 'x' }], userId: 'u1', now: 3000,
    }),
    BadCommitError,
  );
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c4', baseVersion: 1,
    ops: [{ type: 'delete', id: 'l1' }], userId: 'u1', now: 4000,
  });
  await assert.rejects(
    storage.commit({
      projectId: project.id, pageId: 'pg1', commitId: 'c5', baseVersion: 2,
      ops: [{ type: 'insert', id: 'l2', after: '_head', text: 'again' }],
      userId: 'u1', now: 5000,
    }),
    BadCommitError,
  );
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/storage/hash.ts`。実装後に `not implemented: commit` 由来の失敗が残るのが正しい途中経過）

- [ ] **Step 3: opsHash を実装する**

`src/storage/hash.ts`:

```ts
import { createHash } from 'node:crypto';
import type { LineOp } from '../core/ops.ts';

/**
 * 再送の同一性判定に使う正規化ハッシュ。
 * 受信 JSON のキー順に依存しないよう、op を固定のフィールド順に詰め替えてから直列化する。
 */
export function opsHash(pageId: string, baseVersion: number, ops: LineOp[]): string {
  const canonical = ops.map((op) => {
    if (op.type === 'insert') return { type: op.type, id: op.id, after: op.after, text: op.text };
    if (op.type === 'update') return { type: op.type, id: op.id, text: op.text };
    return { type: op.type, id: op.id };
  });
  return createHash('sha256')
    .update(JSON.stringify({ pageId, baseVersion, ops: canonical }))
    .digest('hex');
}
```

- [ ] **Step 4: commit を実装する**

`src/storage/sqlite.ts` の import を次のように変更する（`import type { Line } from '../core/ops.ts';` を置き換え、types の import に `BadCommitError` を加える）:

```ts
import { OpsError, type Line, type LineOp } from '../core/ops.ts';
import { applyOps } from '../core/apply.ts';
import { titleLc } from '../core/title.ts';
import { opsHash } from './hash.ts';
import {
  BadCommitError,
  StorageError,
  type CommitInput,
  type CommitResult,
  type DisplayUser,
  type ImportPageInput,
  type ImportPageResult,
  type PageMeta,
  type PageSnapshot,
  type Project,
  type SearchHit,
  type Storage,
} from './types.ts';
```

`commit` スタブを次で置き換える:

```ts
  async commit(input: CommitInput): Promise<CommitResult> {
    return this.#tx(() => this.#applyCommit(input));
  }

  #applyCommit(input: CommitInput): CommitResult {
    const { projectId, pageId, commitId, baseVersion, ops, userId, now } = input;

    const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
    if (!row && baseVersion !== 0) throw new BadCommitError(`unknown page: ${pageId}`);
    if (row && row.project_id !== projectId) {
      throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
    }
    if (row && row.deleted === 1) throw new BadCommitError(`page ${pageId} is deleted`);
    if (row && baseVersion !== row.version) {
      return { kind: 'conflict', reason: 'version', page: this.#snapshot(row) };
    }

    const currentLines = row ? this.#getLines(pageId) : [];
    const version = baseVersion + 1;
    let newLines: Line[];
    try {
      newLines = applyOps(currentLines, ops, { userId, now, version });
    } catch (e) {
      if (e instanceof OpsError) throw new BadCommitError(e.message);
      throw e;
    }

    const deleted = newLines.length === 0;
    const newTitle = deleted ? (row ? row.title : '') : newLines[0].text;
    const newTitleLc = titleLc(newTitle);

    if (!deleted && (!row || newTitleLc !== row.title_lc)) {
      const clash = this.#db
        .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0 AND id != ?')
        .get(projectId, newTitleLc, pageId) as PageRow | undefined;
      if (clash) return { kind: 'conflict', reason: 'title', page: this.#snapshot(clash) };
    }

    if (!row) {
      this.#db
        .prepare(
          `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
           VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
        )
        .run(pageId, projectId, newTitle, newTitleLc, version, deleted ? 1 : 0, now, now);
    } else {
      if (!deleted && newTitle !== row.title) {
        const started = this.#db
          .prepare('SELECT COALESCE(MAX(ended), ?) AS s FROM title_history WHERE page_id = ?')
          .get(row.created, pageId) as { s: number };
        this.#db
          .prepare('INSERT INTO title_history (page_id, old_title, old_title_lc, started, ended) VALUES (?, ?, ?, ?, ?)')
          .run(pageId, row.title, row.title_lc, started.s, now);
      }
      this.#db
        .prepare('UPDATE pages SET title = ?, title_lc = ?, version = ?, deleted = ?, updated = ? WHERE id = ?')
        .run(newTitle, newTitleLc, version, deleted ? 1 : 0, now, pageId);
    }

    this.#writeLines(pageId, newLines);
    this.#insertCommit(commitId, pageId, baseVersion, version, userId, now, ops);
    return { kind: 'applied', version };
  }

  #writeLines(pageId: string, lines: Line[]): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => {
      st.run(l.id, pageId, ord, l.text, l.created, l.updated, l.updatedVersion, l.userId);
    });
  }

  #insertCommit(
    commitId: string,
    pageId: string,
    baseVersion: number,
    version: number,
    userId: string,
    now: number,
    ops: LineOp[],
  ): void {
    this.#db
      .prepare(
        `INSERT INTO commits (id, page_id, base_version, version, user_id, created, ops, ops_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(commitId, pageId, baseVersion, version, userId, now, JSON.stringify(ops), opsHash(pageId, baseVersion, ops));
  }
```

設計メモ:
- タイトル衝突の事前チェックは `BEGIN IMMEDIATE` の書き込みロック内で行うため、レースにならない。
- conflict は throw ではなく return なので `#tx` は COMMIT するが、その時点で何も書いていないため無害。
- 行順は「コミットの逐次適用だけで決まる」ため、`lines` は全削除 + `applyOps` の結果順で ord を振り直す（v1 の仕様どおり全行振り直し）。

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 6: Commit**

```bash
git add src/storage/hash.ts src/storage/sqlite.ts test/storage/commit.test.ts
git commit -m "feat(storage): コミットのトランザクション適用と 409/400 処理を追加"
```

---

### Task 4: コミットの冪等性

仕様: 同じ commitId かつ同じ内容（正規化ハッシュ一致）の再送は、最初に適用したときの version を成功として返し、二度適用しない。
同じ commitId で内容が異なる要求は 400 で拒否する。
DB（commits テーブル）に持つため、プロセス再起動後も保たれる。

**Files:**
- Modify: `src/storage/sqlite.ts`（`#applyCommit` の冒頭に再送チェックを追加)
- Test: `test/storage/idempotency.test.ts`

**Interfaces:**
- Consumes: Task 3 の `commit` / `opsHash`
- Produces: 同シグネチャのまま冪等になった `commit`

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/idempotency.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { BadCommitError, type CommitInput } from '../../src/storage/types.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  const first: CommitInput = {
    projectId: project.id,
    pageId: 'pg1',
    commitId: 'c1',
    baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    userId: 'u1',
    now: 2000,
  };
  await storage.commit(first);
  return { db, storage, project, first };
}

test('同一 commitId 同一内容の再送は最初の version を返し、二度適用しない', async () => {
  const { db, storage, first } = await setup();
  const replay = await storage.commit(first);
  assert.deepEqual(replay, { kind: 'applied', version: 1 });
  const count = (db.prepare('SELECT count(*) AS c FROM commits').get() as { c: number }).c;
  assert.equal(count, 1);
  const version = (db.prepare('SELECT version FROM pages WHERE id = ?').get('pg1') as { version: number }).version;
  assert.equal(version, 1);
  await storage.close();
});

test('他のコミットが挟まった後の再送でも conflict にならず最初の version を返す', async () => {
  const { storage, project, first } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'insert', id: 'l2', after: 'l1', text: 'x' }],
    userId: 'u2', now: 3000,
  });
  const replay = await storage.commit(first);
  assert.deepEqual(replay, { kind: 'applied', version: 1 });
  await storage.close();
});

test('同一 commitId で内容が異なる要求は BadCommitError', async () => {
  const { storage, first } = await setup();
  await assert.rejects(
    storage.commit({ ...first, ops: [{ type: 'insert', id: 'l1', after: '_head', text: '別内容' }] }),
    BadCommitError,
  );
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（再送が `duplicate line id` の BadCommitError になる、または commits の PRIMARY KEY 違反で落ちる）

- [ ] **Step 3: 再送チェックを実装する**

`src/storage/sqlite.ts` の `#applyCommit` 冒頭、`const { projectId, ... } = input;` の直後に追加:

```ts
    const prior = this.#db
      .prepare('SELECT version, ops_hash FROM commits WHERE id = ?')
      .get(commitId) as { version: number; ops_hash: string } | undefined;
    if (prior) {
      if (prior.ops_hash !== opsHash(pageId, baseVersion, ops)) {
        throw new BadCommitError(`commit ${commitId} was already applied with different content`);
      }
      return { kind: 'applied', version: prior.version };
    }
```

ページの存在・削除・baseVersion のどのチェックよりも先に行うこと（削除済みページや進んだ version への「再送」も、最初の適用結果を返すのが冪等の意味である）。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite.ts test/storage/idempotency.test.ts
git commit -m "feat(storage): コミット再送の冪等性を追加"
```

---

### Task 5: 導出データ（links / pages_fts / pages.image）

仕様: links・pages_fts・pages.image は lines から再構築できる導出データで、コミット適用時に更新する。
ページの全文（先頭行 = タイトルを含む）を `extractRefs` に渡してリンク先と代表画像を取り、FTS には全行連結テキストを索引させる。

**Files:**
- Modify: `src/storage/sqlite.ts`（`#updateDerived` を追加し `#applyCommit` から呼ぶ）
- Test: `test/storage/derived.test.ts`

**Interfaces:**
- Consumes: `extractRefs(text: string): PageRefs`（core、`{ linkTargets: string[]; image: string | null }` を返す）
- Produces: private `#updateDerived(projectId: string, pageId: string, lines: Line[], deleted: boolean): void`（Task 7 の reindex、Task 8 の importPage が再利用する）

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/derived.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  return { db, storage, project };
}

test('コミットで links にリンク先 title_lc が入る', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [
      { type: 'insert', id: 'l1', after: '_head', text: 'ホーム' },
      { type: 'insert', id: 'l2', after: 'l1', text: '[Foo Bar] と #タグ を張る' },
    ],
    userId: 'u1', now: 2000,
  });
  const targets = (
    db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ? ORDER BY target_title_lc').all('pg1') as {
      target_title_lc: string;
    }[]
  ).map((r) => r.target_title_lc);
  assert.deepEqual(targets, ['foo_bar', 'タグ']);
  await storage.close();
});

test('pages.image は最初の画像 URL になり、無ければ NULL', async () => {
  const { storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [
      { type: 'insert', id: 'l1', after: '_head', text: '画像ページ' },
      { type: 'insert', id: 'l2', after: 'l1', text: '[https://gyazo.com/abc123]' },
      { type: 'insert', id: 'l3', after: 'l2', text: '[https://example.com/second.png]' },
    ],
    userId: 'u1', now: 2000,
  });
  const page = await storage.getPageByTitle(project.id, '画像ページ');
  assert.ok(page);
  assert.equal(page.image, 'https://gyazo.com/abc123');

  await storage.commit({
    projectId: project.id, pageId: 'pg2', commitId: 'c2', baseVersion: 0,
    ops: [{ type: 'insert', id: 'm1', after: '_head', text: '画像なし' }],
    userId: 'u1', now: 2000,
  });
  const plain = await storage.getPageByTitle(project.id, '画像なし');
  assert.ok(plain);
  assert.equal(plain.image, null);
  await storage.close();
});

test('コミットで pages_fts が更新され、タイトル変更にも追随する', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: '検索対象ページ' }],
    userId: 'u1', now: 2000,
  });
  const match = db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?');
  assert.equal(match.all('"検索対象"').length, 1);
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'update', id: 'l1', text: '改名済みページ' }],
    userId: 'u1', now: 3000,
  });
  assert.equal(match.all('"検索対象"').length, 0);
  assert.equal(match.all('"改名済み"').length, 1);
  // fts の行はページごとに 1 行だけ
  const count = (db.prepare('SELECT count(*) AS c FROM pages_fts').get() as { c: number }).c;
  assert.equal(count, 1);
  await storage.close();
});

test('ページ削除で links と fts が消え image が NULL になる', async () => {
  const { db, storage, project } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [
      { type: 'insert', id: 'l1', after: '_head', text: '消えるページ' },
      { type: 'insert', id: 'l2', after: 'l1', text: '[リンク] [https://gyazo.com/x1]' },
    ],
    userId: 'u1', now: 2000,
  });
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [
      { type: 'delete', id: 'l1' },
      { type: 'delete', id: 'l2' },
    ],
    userId: 'u1', now: 3000,
  });
  assert.equal((db.prepare('SELECT count(*) AS c FROM links WHERE source_page_id = ?').get('pg1') as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT count(*) AS c FROM pages_fts WHERE page_id = ?').get('pg1') as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT image FROM pages WHERE id = ?').get('pg1') as { image: string | null }).image, null);
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（links / pages_fts が空、image が NULL のまま）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts` の import に追加:

```ts
import { extractRefs } from '../core/links.ts';
```

`SqliteStorage` にメソッドを追加:

```ts
  #updateDerived(projectId: string, pageId: string, lines: Line[], deleted: boolean): void {
    this.#db.prepare('DELETE FROM links WHERE source_page_id = ?').run(pageId);
    this.#db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    if (deleted) {
      this.#db.prepare('UPDATE pages SET image = NULL WHERE id = ?').run(pageId);
      return;
    }
    const text = lines.map((l) => l.text).join('\n');
    const refs = extractRefs(text);
    const insertLink = this.#db.prepare(
      'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc) VALUES (?, ?, ?)',
    );
    for (const target of refs.linkTargets) insertLink.run(projectId, pageId, target);
    this.#db.prepare('UPDATE pages SET image = ? WHERE id = ?').run(refs.image, pageId);
    this.#db
      .prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)')
      .run(pageId, projectId, text);
  }
```

`#applyCommit` の `this.#insertCommit(...)` 呼び出しの直後（`return { kind: 'applied', version };` の直前）に追加:

```ts
    this.#updateDerived(projectId, pageId, newLines, deleted);
```

設計メモ: 先頭行がタイトルなので、全行連結テキストがスペックの「タイトルと全行を連結したテキスト」に一致する。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite.ts test/storage/derived.test.ts
git commit -m "feat(storage): コミット適用時の導出データ更新を追加"
```

---

### Task 6: 検索（FTS + LIKE フォールバック）

仕様: trigram は 3 文字未満のクエリで索引を引けず 0 件を返すため、クエリが 3 文字（コードポイント）未満なら `lines.text` への LIKE 走査にフォールバックする。
この分岐は storage の検索メソッドの内側に閉じる。

**Files:**
- Modify: `src/storage/sqlite.ts`（`search` スタブを本実装に置き換え）
- Test: `test/storage/search.test.ts`

**Interfaces:**
- Consumes: Task 5 までの `commit`（テストのシード作成に使う）
- Produces: `search(projectId: string, query: string): Promise<SearchHit[]>`（`SearchHit = { pageId, title, lines }`。lines はクエリを含む行のテキスト）

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/search.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  const put = (pageId: string, commitId: string, texts: string[]) =>
    storage.commit({
      projectId: project.id, pageId, commitId, baseVersion: 0,
      ops: texts.map((text, i) => ({
        type: 'insert' as const,
        id: `${pageId}-l${i}`,
        after: i === 0 ? '_head' : `${pageId}-l${i - 1}`,
        text,
      })),
      userId: 'u1', now: 2000,
    });
  await put('pg1', 'c1', ['knot 設計書', '検索の設計を書く']);
  await put('pg2', 'c2', ['雑記', 'A_B というリテラル', '進捗は100%達成です']);
  await put('pg3', 'c3', ['AxB のページ', '関係ない本文']);
  return { db, storage, project };
}

test('3 文字以上は FTS で全文検索し、一致行を返す', async () => {
  const { storage, project } = await setup();
  const hits = await storage.search(project.id, '設計書');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pageId, 'pg1');
  assert.equal(hits[0].title, 'knot 設計書');
  assert.deepEqual(hits[0].lines, ['knot 設計書']);
  await storage.close();
});

test('3 文字未満は LIKE フォールバックで見つかる', async () => {
  const { storage, project } = await setup();
  // FTS(trigram) では 2 文字クエリは 0 件になる（Task 1 で実測済み）
  const hits = await storage.search(project.id, '設計');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pageId, 'pg1');
  assert.deepEqual(hits[0].lines, ['knot 設計書', '検索の設計を書く']);
  await storage.close();
});

test('LIKE のメタ文字はリテラルとして扱う', async () => {
  const { storage, project } = await setup();
  const underscore = await storage.search(project.id, '_');
  assert.deepEqual(underscore.map((h) => h.pageId), ['pg2']);
  const percent = await storage.search(project.id, '100%達成');
  assert.deepEqual(percent.map((h) => h.pageId), ['pg2']);
  await storage.close();
});

test('二重引用符を含むクエリでもクラッシュしない', async () => {
  const { storage, project } = await setup();
  const hits = await storage.search(project.id, 'ab"cd');
  assert.deepEqual(hits, []);
  await storage.close();
});

test('空クエリは 0 件、削除済みページはヒットしない', async () => {
  const { storage, project } = await setup();
  assert.deepEqual(await storage.search(project.id, ''), []);
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c9', baseVersion: 1,
    ops: [
      { type: 'delete', id: 'pg1-l0' },
      { type: 'delete', id: 'pg1-l1' },
    ],
    userId: 'u1', now: 3000,
  });
  assert.deepEqual(await storage.search(project.id, '設計書'), []);
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`not implemented: search`）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts` のモジュールレベル（クラス定義の前）にヘルパを追加:

```ts
function escapeLike(s: string): string {
  return s.replaceAll(/[\\%_]/g, (m) => `\\${m}`);
}
```

`search` スタブを次で置き換える:

```ts
  async search(projectId: string, query: string): Promise<SearchHit[]> {
    if (query === '') return [];
    const pages =
      [...query].length >= 3 ? this.#searchFts(projectId, query) : this.#searchLike(projectId, query);
    const likePattern = `%${escapeLike(query)}%`;
    const matchedLines = this.#db.prepare(
      `SELECT text FROM lines WHERE page_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY ord`,
    );
    return pages.map((p) => ({
      pageId: p.id,
      title: p.title,
      lines: (matchedLines.all(p.id, likePattern) as { text: string }[]).map((r) => r.text),
    }));
  }

  #searchFts(projectId: string, query: string): { id: string; title: string }[] {
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return this.#db
      .prepare(
        `SELECT p.id, p.title FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND pages_fts.project_id = ? AND p.deleted = 0
         ORDER BY pages_fts.rank`,
      )
      .all(phrase, projectId) as { id: string; title: string }[];
  }

  #searchLike(projectId: string, query: string): { id: string; title: string }[] {
    const pattern = `%${escapeLike(query)}%`;
    return this.#db
      .prepare(
        `SELECT DISTINCT p.id, p.title, p.updated FROM pages p JOIN lines l ON l.page_id = p.id
         WHERE p.project_id = ? AND p.deleted = 0 AND l.text LIKE ? ESCAPE '\\'
         ORDER BY p.updated DESC`,
      )
      .all(projectId, pattern) as { id: string; title: string }[];
  }
```

設計メモ:
- FTS の `MATCH` はテーブル別名を受け付けないため、`pages_fts` は別名なしで JOIN する（Global Constraints 参照）。
- FTS クエリは全体を二重引用符でくくったフレーズ 1 個に正規化し、演算子（AND / OR / `*`）の解釈を防ぐ。
- 一致行の抽出は両経路とも LIKE で行う。trigram は行をまたぐ一致（連結テキスト中の改行を挟む一致）を返し得るが、その場合 lines が空になるだけで、ヒット自体は title で提示できる。

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite.ts test/storage/search.test.ts
git commit -m "feat(storage): FTS5 全文検索と LIKE フォールバックを追加"
```

---

### Task 7: reindex（導出データの再構築）

仕様: links・pages_fts・pages.image は `knot reindex` で全部作り直せる。
索引の破損対策と、リンク抽出ロジック変更時の再適用手段を兼ねる。
pages 行は物理削除されない（不変条件）ため、ページごとに `#updateDerived` を呼び直せば孤児行も残らない。

**Files:**
- Modify: `src/storage/sqlite.ts`（`reindex` スタブを本実装に置き換え）
- Test: `test/storage/reindex.test.ts`

**Interfaces:**
- Consumes: `#updateDerived`（Task 5）
- Produces: `reindex(projectId?: string): Promise<{ pages: number }>`（projectId 省略時は全プロジェクト）

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/reindex.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c1', baseVersion: 0,
    ops: [
      { type: 'insert', id: 'l1', after: '_head', text: 'ホーム' },
      { type: 'insert', id: 'l2', after: 'l1', text: '[リンク先] と [https://gyazo.com/img1]' },
    ],
    userId: 'u1', now: 2000,
  });
  // 導出データを壊す
  db.prepare('DELETE FROM links').run();
  db.prepare('DELETE FROM pages_fts').run();
  db.prepare("UPDATE pages SET image = 'https://wrong.example/x.png' WHERE id = 'pg1'").run();
  return { db, storage, project };
}

test('reindex が links / fts / image を lines から再構築する', async () => {
  const { db, storage } = await setup();
  const result = await storage.reindex();
  assert.equal(result.pages, 1);
  const targets = (
    db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all('pg1') as {
      target_title_lc: string;
    }[]
  ).map((r) => r.target_title_lc);
  assert.deepEqual(targets, ['リンク先']);
  assert.equal(db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?').all('"リンク先"').length, 1);
  const image = (db.prepare('SELECT image FROM pages WHERE id = ?').get('pg1') as { image: string | null }).image;
  assert.equal(image, 'https://gyazo.com/img1');
  await storage.close();
});

test('reindex は削除済みページの残骸も掃除する', async () => {
  const { db, storage, project } = await setup();
  await storage.reindex();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [
      { type: 'delete', id: 'l1' },
      { type: 'delete', id: 'l2' },
    ],
    userId: 'u1', now: 3000,
  });
  // 削除済みページに残骸を仕込む
  db.prepare("INSERT INTO links (project_id, source_page_id, target_title_lc) VALUES (?, 'pg1', 'ゴミ')").run(project.id);
  db.prepare("INSERT INTO pages_fts (page_id, project_id, content) VALUES ('pg1', ?, 'ゴミ')").run(project.id);
  const result = await storage.reindex();
  assert.equal(result.pages, 1);
  assert.equal((db.prepare('SELECT count(*) AS c FROM links WHERE source_page_id = ?').get('pg1') as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT count(*) AS c FROM pages_fts WHERE page_id = ?').get('pg1') as { c: number }).c, 0);
  await storage.close();
});

test('projectId を指定すると、そのプロジェクトのページだけ数える', async () => {
  const { db, storage } = await setup();
  const other = await storage.ensureProject('other', 1000);
  await storage.commit({
    projectId: other.id, pageId: 'pg9', commitId: 'c9', baseVersion: 0,
    ops: [{ type: 'insert', id: 'm1', after: '_head', text: '別プロジェクト' }],
    userId: 'u1', now: 2000,
  });
  const result = await storage.reindex(other.id);
  assert.equal(result.pages, 1);
  // wiki 側の壊した導出データは直っていない（対象外だった）
  assert.equal((db.prepare('SELECT count(*) AS c FROM links WHERE source_page_id = ?').get('pg1') as { c: number }).c, 0);
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`not implemented: reindex`）

- [ ] **Step 3: 実装する**

`src/storage/sqlite.ts` の `reindex` スタブを次で置き換える:

```ts
  async reindex(projectId?: string): Promise<{ pages: number }> {
    return this.#tx(() => {
      const rows = (
        projectId === undefined
          ? this.#db.prepare('SELECT * FROM pages').all()
          : this.#db.prepare('SELECT * FROM pages WHERE project_id = ?').all(projectId)
      ) as PageRow[];
      for (const row of rows) {
        this.#updateDerived(row.project_id, row.id, this.#getLines(row.id), row.deleted === 1);
      }
      return { pages: rows.length };
    });
  }
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: Commit**

```bash
git add src/storage/sqlite.ts test/storage/reindex.test.ts
git commit -m "feat(storage): 導出データを再構築する reindex を追加"
```

---

### Task 8: インポート

仕様（スペック「インポートとエクスポート」節）:
Cosense のエクスポート JSON を無加工で受け付け、行のタイムスタンプ・userId・ID を保持する。
メタデータが null の行はインポート時刻とインポート実行ユーザーで埋める（core の `NormalizedLine` の約束）。
タイトル衝突は「スキップ」「上書き」から選び、既定はスキップ。
インポートも内部的にはコミットとして記録する（不変条件: すべての書き込みが commits に残る）。
`users` 配列は表示専用ユーザー（password_hash なし）として取り込む。

行メタデータを保持するため、インポートは `applyOps` の経路（now/userId で上書きスタンプする）を通らず、`importPage` が lines を直接書き、対応する insert/delete ops のコミット行を添える。
トランザクションはページ単位とする（巨大エクスポートを単一トランザクションにしない設計判断。途中で失敗した場合、そこまでのページは取り込まれた状態で止まる）。

**Files:**
- Create: `src/storage/import.ts`
- Modify: `src/storage/sqlite.ts`（`importPage` スタブを本実装に置き換え）
- Test: `test/storage/import.test.ts`

**Interfaces:**
- Consumes: `parseExportFile` / `normalizeLines`（core、Task 0 で強化済み）、`ulid`（core）、`#insertCommit` / `#updateDerived` / `#writeLines` 相当（Task 3・5）、`upsertDisplayUser`（Task 2）
- Produces: `importCosense(storage: Storage, data: unknown, options: ImportOptions): Promise<ImportSummary>`、`ImportOptions = { projectName: string; onConflict?: 'skip' | 'overwrite'; now?: number }`、`ImportSummary = { created: number; overwritten: number; skipped: number; users: number }`、定数 `IMPORTER_USER_NAME = 'knot-import'`、`importPage`（本実装）

- [ ] **Step 1: 失敗するテストを書く**

`test/storage/import.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { importCosense, IMPORTER_USER_NAME } from '../../src/storage/import.ts';
import { StorageError } from '../../src/storage/types.ts';
import type { CosenseExport, CosenseLine } from '../../src/core/cosense.ts';

// CosenseExport で注釈しておくと、lines 要素の書き換えが union 配列への代入エラーにならない
const fixture = (): CosenseExport => ({
  name: 'sandbox',
  displayName: 'Sandbox',
  exported: 1751000000,
  users: [{ id: '5f1a2b3c4d5e6f7a8b9c0d1e', name: 'alice', displayName: 'Alice' }],
  pages: [
    {
      id: '61f0c1d2e3a4b5c6d7e8f901',
      title: 'メタデータ付きページ',
      created: 1750000000,
      updated: 1750001000,
      lines: [
        {
          id: '61f0c1d2e3a4b5c6d7e8f902',
          text: 'メタデータ付きページ',
          userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
          created: 1750000000,
          updated: 1750000000,
        },
        {
          id: '61f0c1d2e3a4b5c6d7e8f903',
          text: '[リンク先] を張る',
          userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
          created: 1750000000,
          updated: 1750001000,
        },
      ],
    },
    {
      title: '簡易形式のページ',
      lines: ['簡易形式のページ', '文字列だけの行'],
    },
  ],
});

test('メタデータ付きの行が ID・時刻・userId ごと保存される', async () => {
  const { storage } = makeStorage();
  const summary = await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  assert.deepEqual(summary, { created: 2, overwritten: 0, skipped: 0, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.id, '61f0c1d2e3a4b5c6d7e8f901');
  assert.equal(page.created, 1750000000);
  assert.equal(page.version, 1);
  assert.deepEqual(
    page.lines.map((l) => ({ id: l.id, created: l.created, updated: l.updated, userId: l.userId })),
    [
      { id: '61f0c1d2e3a4b5c6d7e8f902', created: 1750000000, updated: 1750000000, userId: '5f1a2b3c4d5e6f7a8b9c0d1e' },
      { id: '61f0c1d2e3a4b5c6d7e8f903', created: 1750000000, updated: 1750001000, userId: '5f1a2b3c4d5e6f7a8b9c0d1e' },
    ],
  );
  await storage.close();
});

test('文字列行はインポート時刻と knot-import ユーザーで埋まる', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, '簡易形式のページ');
  assert.ok(page);
  const importer = db.prepare('SELECT id, password_hash FROM users WHERE name = ?').get(IMPORTER_USER_NAME) as {
    id: string; password_hash: string | null;
  };
  assert.equal(importer.password_hash, null);
  for (const line of page.lines) {
    assert.equal(line.created, 1760000000);
    assert.equal(line.userId, importer.id);
    assert.match(line.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  }
  await storage.close();
});

test('インポートはコミットとして残り、導出データも更新される', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const commit = db
    .prepare('SELECT base_version, version, ops FROM commits WHERE page_id = ?')
    .get('61f0c1d2e3a4b5c6d7e8f901') as { base_version: number; version: number; ops: string };
  assert.equal(commit.base_version, 0);
  assert.equal(commit.version, 1);
  const ops = JSON.parse(commit.ops) as { type: string; text?: string }[];
  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, 'insert');
  assert.equal(ops[0].text, 'メタデータ付きページ');
  const links = (
    db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all('61f0c1d2e3a4b5c6d7e8f901') as {
      target_title_lc: string;
    }[]
  ).map((r) => r.target_title_lc);
  assert.deepEqual(links, ['リンク先']);
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const hits = await storage.search(project.id, 'リンク先');
  assert.equal(hits.length, 1);
  await storage.close();
});

test('再インポートは既定でスキップされ、内容が変わらない', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const summary = await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1770000000 });
  assert.deepEqual(summary, { created: 0, overwritten: 0, skipped: 2, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.version, 1);
  assert.equal(page.lines[0].created, 1750000000);
  await storage.close();
});

test('overwrite は既存ページを新しいコミットとして置き換える', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const modified = fixture();
  modified.pages[0].lines[1] = {
    id: '61f0c1d2e3a4b5c6d7e8f903',
    text: '書き換えた行',
    userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
    created: 1750000000,
    updated: 1755000000,
  };
  const summary = await importCosense(storage, modified, {
    projectName: 'sandbox', onConflict: 'overwrite', now: 1770000000,
  });
  assert.deepEqual(summary, { created: 0, overwritten: 2, skipped: 0, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.version, 2);
  assert.equal(page.lines[1].text, '書き換えた行');
  assert.equal(page.lines[1].updated, 1755000000);
  // 上書きも commits に残る（delete + insert の ops）
  const commits = db
    .prepare('SELECT ops FROM commits WHERE page_id = ? ORDER BY version')
    .all('61f0c1d2e3a4b5c6d7e8f901') as { ops: string }[];
  assert.equal(commits.length, 2);
  const secondOps = JSON.parse(commits[1].ops) as { type: string }[];
  assert.equal(secondOps[0].type, 'delete');
  assert.equal(secondOps.at(-1)?.type, 'insert');
  await storage.close();
});

test('page id が衝突したら新しい ULID で取り込む（別プロジェクトへの同一エクスポート）', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const summary = await importCosense(storage, fixture(), { projectName: 'mirror', now: 1770000000 });
  assert.deepEqual(summary, { created: 2, overwritten: 0, skipped: 0, users: 1 });
  const mirror = await storage.getProject('mirror');
  assert.ok(mirror);
  const page = await storage.getPageByTitle(mirror.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.notEqual(page.id, '61f0c1d2e3a4b5c6d7e8f901');
  assert.match(page.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  await storage.close();
});

test('不正な JSON と重複行 ID は拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(importCosense(storage, { nope: true }, { projectName: 'sandbox' }), /pages/);
  const dup = fixture();
  const line1 = dup.pages[0].lines[1] as Exclude<CosenseLine, string>;
  dup.pages[0].lines[1] = { ...line1, id: '61f0c1d2e3a4b5c6d7e8f902' };
  await assert.rejects(importCosense(storage, dup, { projectName: 'sandbox' }), StorageError);
  // 失敗したページは作られていない
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  assert.equal(await storage.getPageByTitle(project.id, 'メタデータ付きページ'), null);
  await storage.close();
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/storage/import.ts`）

- [ ] **Step 3: importPage を実装する**

`src/storage/sqlite.ts` の types import に `ImportLine` を追加し、`importPage` スタブを次で置き換える:

```ts
  async importPage(input: ImportPageInput): Promise<ImportPageResult> {
    return this.#tx(() => {
      const { projectId, page, lines, userId, now, onConflict } = input;
      if (lines.length === 0) throw new StorageError(`page "${page.title}" has no lines`);
      const seen = new Set<string>();
      for (const line of lines) {
        if (seen.has(line.id)) throw new StorageError(`duplicate line id in page "${page.title}": ${line.id}`);
        seen.add(line.id);
      }
      const lcValue = titleLc(page.title);
      const existing = this.#db
        .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
        .get(projectId, lcValue) as PageRow | undefined;

      if (existing && onConflict === 'skip') return { kind: 'skipped' as const, pageId: existing.id };

      const insertOps: LineOp[] = lines.map((l, i) => ({
        type: 'insert' as const,
        id: l.id,
        after: i === 0 ? '_head' : lines[i - 1].id,
        text: l.text,
      }));

      if (existing) {
        const deleteOps: LineOp[] = this.#getLines(existing.id).map((l) => ({ type: 'delete' as const, id: l.id }));
        const version = existing.version + 1;
        this.#writeImportedLines(existing.id, lines, version);
        this.#db
          .prepare('UPDATE pages SET title = ?, version = ?, updated = ? WHERE id = ?')
          .run(page.title, version, now, existing.id);
        this.#insertCommit(ulid(now * 1000), existing.id, existing.version, version, userId, now, [
          ...deleteOps,
          ...insertOps,
        ]);
        this.#updateDerived(projectId, existing.id, this.#getLines(existing.id), false);
        return { kind: 'overwritten' as const, pageId: existing.id };
      }

      const idTaken = this.#db.prepare('SELECT 1 AS x FROM pages WHERE id = ?').get(page.id) !== undefined;
      const pageId = idTaken ? ulid(now * 1000) : page.id;
      this.#db
        .prepare(
          `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
           VALUES (?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)`,
        )
        .run(pageId, projectId, page.title, lcValue, page.created, page.updated);
      this.#writeImportedLines(pageId, lines, 1);
      this.#insertCommit(ulid(now * 1000), pageId, 0, 1, userId, now, insertOps);
      this.#updateDerived(projectId, pageId, this.#getLines(pageId), false);
      return { kind: 'created' as const, pageId };
    });
  }

  #writeImportedLines(pageId: string, lines: ImportLine[], version: number): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => st.run(l.id, pageId, ord, l.text, l.created, l.updated, version, l.userId));
  }
```

- [ ] **Step 4: importCosense を実装する**

`src/storage/import.ts`:

```ts
import { normalizeLines, parseExportFile } from '../core/cosense.ts';
import { ulid } from '../core/id.ts';
import type { ImportLine, Storage } from './types.ts';

export const IMPORTER_USER_NAME = 'knot-import';

export type ImportOptions = {
  projectName: string;
  onConflict?: 'skip' | 'overwrite';
  now?: number;
};

export type ImportSummary = { created: number; overwritten: number; skipped: number; users: number };

export async function importCosense(storage: Storage, data: unknown, options: ImportOptions): Promise<ImportSummary> {
  const exp = parseExportFile(data);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const onConflict = options.onConflict ?? 'skip';
  const project = await storage.ensureProject(options.projectName, now);

  const importerId = await storage.upsertDisplayUser(
    { id: ulid(now * 1000), name: IMPORTER_USER_NAME, displayName: IMPORTER_USER_NAME },
    now,
  );
  const users = exp.users ?? [];
  for (const user of users) {
    await storage.upsertDisplayUser({ id: user.id, name: user.name, displayName: user.displayName ?? user.name }, now);
  }

  const summary: ImportSummary = { created: 0, overwritten: 0, skipped: 0, users: users.length };
  for (const page of exp.pages) {
    const lines: ImportLine[] = normalizeLines(page).map((line) => ({
      id: line.id ?? ulid(now * 1000),
      text: line.text,
      created: line.created ?? now,
      updated: line.updated ?? now,
      userId: line.userId ?? importerId,
    }));
    const result = await storage.importPage({
      projectId: project.id,
      page: {
        id: page.id ?? ulid(now * 1000),
        title: page.title,
        created: page.created ?? now,
        updated: page.updated ?? now,
      },
      lines,
      userId: importerId,
      now,
      onConflict,
    });
    summary[result.kind]++;
  }
  return summary;
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 6: Commit**

```bash
git add src/storage/import.ts src/storage/sqlite.ts test/storage/import.test.ts
git commit -m "feat(storage): Cosense エクスポート JSON のインポートを追加"
```

---

### Task 9: エクスポートと round-trip

仕様: エクスポートは Cosense エクスポートと同じ構造の JSON（行メタデータ込み）。
`import` 形式では行を文字列配列にし、Cosense のインポート機能へ直接渡せる形にする。
削除済みページは含めない。
受け入れ条件は「実データ形式の round-trip」: インポート → エクスポートで、ページ数・行テキスト・タイムスタンプ・userId が保存されること。

**Files:**
- Create: `src/storage/export.ts`
- Create: `test/fixtures/cosense-export.json`
- Test: `test/storage/export.test.ts`

**Interfaces:**
- Consumes: `getProject` / `listPages` / `getPageById` / `listUsersForProject`（Task 2）、`CosenseExport` 型（core）
- Produces: `exportCosense(storage: Storage, projectName: string, format: ExportFormat, now: number): Promise<CosenseExport>`、`ExportFormat = 'full' | 'import'`

- [ ] **Step 1: フィクスチャを作る**

`test/fixtures/cosense-export.json`（実際の Cosense エクスポートと同じ構造。オブジェクト行・文字列行・リンク・画像・空白入りタイトルを含む）:

```json
{
  "name": "sandbox",
  "displayName": "Sandbox",
  "exported": 1751000000,
  "users": [
    { "id": "5f1a2b3c4d5e6f7a8b9c0d1e", "name": "alice", "displayName": "Alice" },
    { "id": "6a2b3c4d5e6f7a8b9c0d1e2f", "name": "bob", "displayName": "Bob" }
  ],
  "pages": [
    {
      "id": "61f0c1d2e3a4b5c6d7e8f901",
      "title": "knot 設計メモ",
      "created": 1750000000,
      "updated": 1750001000,
      "lines": [
        { "id": "61f0c1d2e3a4b5c6d7e8f902", "text": "knot 設計メモ", "userId": "5f1a2b3c4d5e6f7a8b9c0d1e", "created": 1750000000, "updated": 1750000000 },
        { "id": "61f0c1d2e3a4b5c6d7e8f903", "text": "[Cosense 互換] を目指す #wiki", "userId": "5f1a2b3c4d5e6f7a8b9c0d1e", "created": 1750000000, "updated": 1750001000 },
        { "id": "61f0c1d2e3a4b5c6d7e8f904", "text": "[https://gyazo.com/0123456789abcdef01234567] スクリーンショット", "userId": "6a2b3c4d5e6f7a8b9c0d1e2f", "created": 1750000500, "updated": 1750000500 },
        { "id": "61f0c1d2e3a4b5c6d7e8f905", "text": "\tインデント行と `code` を含む", "userId": "6a2b3c4d5e6f7a8b9c0d1e2f", "created": 1750000600, "updated": 1750000600 }
      ]
    },
    {
      "id": "61f0c1d2e3a4b5c6d7e8f906",
      "title": "Cosense 互換",
      "created": 1750002000,
      "updated": 1750002000,
      "lines": [
        { "id": "61f0c1d2e3a4b5c6d7e8f907", "text": "Cosense 互換", "userId": "5f1a2b3c4d5e6f7a8b9c0d1e", "created": 1750002000, "updated": 1750002000 },
        { "id": "61f0c1d2e3a4b5c6d7e8f908", "text": "読み取り API と export/import を合わせる", "userId": "5f1a2b3c4d5e6f7a8b9c0d1e", "created": 1750002000, "updated": 1750002000 }
      ]
    },
    {
      "title": "簡易形式のページ",
      "lines": ["簡易形式のページ", "文字列だけの行", "空白 と _ を含む [knot 設計メモ] へのリンク"]
    }
  ]
}
```

- [ ] **Step 2: 失敗するテストを書く**

`test/storage/export.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeStorage } from '../helpers/storage.ts';
import { importCosense } from '../../src/storage/import.ts';
import { exportCosense } from '../../src/storage/export.ts';
import { normalizeLines, parseExportFile, type CosenseLine } from '../../src/core/cosense.ts';

const FIXTURE_URL = new URL('../fixtures/cosense-export.json', import.meta.url);
const loadFixture = () => JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as unknown;

type ObjectLine = Exclude<CosenseLine, string>;

test('round-trip: インポート → エクスポートで意味が保存される', async () => {
  const { storage } = makeStorage();
  const data = loadFixture();
  await importCosense(storage, data, { projectName: 'sandbox', now: 1760000000 });
  const out = await exportCosense(storage, 'sandbox', 'full', 1760000001);
  const src = parseExportFile(data);

  assert.equal(out.name, 'sandbox');
  assert.equal(out.exported, 1760000001);
  assert.equal(out.pages.length, src.pages.length);
  for (const page of src.pages) {
    const got = out.pages.find((p) => p.title === page.title);
    assert.ok(got, `${page.title} が出力にない`);
    const srcLines = normalizeLines(page);
    const gotLines = got.lines as ObjectLine[];
    assert.deepEqual(gotLines.map((l) => l.text), srcLines.map((l) => l.text));
    srcLines.forEach((l, i) => {
      if (l.id !== null) assert.equal(gotLines[i].id, l.id);
      if (l.created !== null) assert.equal(gotLines[i].created, l.created);
      if (l.updated !== null) assert.equal(gotLines[i].updated, l.updated);
      if (l.userId !== null) assert.equal(gotLines[i].userId, l.userId);
    });
    if (page.id !== undefined) assert.equal(got.id, page.id);
    if (page.created !== undefined) assert.equal(got.created, page.created);
    if (page.updated !== undefined) assert.equal(got.updated, page.updated);
  }
  const userNames = (out.users ?? []).map((u) => u.name);
  assert.ok(userNames.includes('alice'));
  assert.ok(userNames.includes('bob'));
  await storage.close();
});

test('export → import → export が安定する', async () => {
  const first = makeStorage();
  await importCosense(first.storage, loadFixture(), { projectName: 'sandbox', now: 1760000000 });
  const out1 = await exportCosense(first.storage, 'sandbox', 'full', 1760000001);
  await first.storage.close();

  const second = makeStorage();
  await importCosense(second.storage, out1, { projectName: 'sandbox', now: 1770000000 });
  const out2 = await exportCosense(second.storage, 'sandbox', 'full', 1760000001);
  await second.storage.close();

  const byTitle = (pages: typeof out1.pages) => [...pages].sort((a, b) => a.title.localeCompare(b.title));
  assert.deepEqual(byTitle(out2.pages), byTitle(out1.pages));
});

test('format=import は行を文字列配列で出す', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, loadFixture(), { projectName: 'sandbox', now: 1760000000 });
  const out = await exportCosense(storage, 'sandbox', 'import', 1760000001);
  for (const page of out.pages) {
    for (const line of page.lines) assert.equal(typeof line, 'string');
  }
  await storage.close();
});

test('削除済みページはエクスポートに含まれない', async () => {
  const { storage } = makeStorage();
  const data = loadFixture();
  await importCosense(storage, data, { projectName: 'sandbox', now: 1760000000 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'cosense_互換');
  assert.ok(page);
  await storage.commit({
    projectId: project.id,
    pageId: page.id,
    commitId: 'del1',
    baseVersion: page.version,
    ops: page.lines.map((l) => ({ type: 'delete' as const, id: l.id })),
    userId: 'u1',
    now: 1760000500,
  });
  const out = await exportCosense(storage, 'sandbox', 'full', 1760001000);
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages.find((p) => p.title === 'Cosense 互換'), undefined);
  await storage.close();
});

test('存在しないプロジェクトのエクスポートは拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(exportCosense(storage, 'nope', 'full', 1), /unknown project/);
  await storage.close();
});
```

- [ ] **Step 3: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/storage/export.ts`）

- [ ] **Step 4: 実装する**

`src/storage/export.ts`:

```ts
import type { CosenseExport, CosenseLine, CosensePage } from '../core/cosense.ts';
import { StorageError, type Storage } from './types.ts';

export type ExportFormat = 'full' | 'import';

export async function exportCosense(
  storage: Storage,
  projectName: string,
  format: ExportFormat,
  now: number,
): Promise<CosenseExport> {
  const project = await storage.getProject(projectName);
  if (!project) throw new StorageError(`unknown project: ${projectName}`);

  const pages: CosensePage[] = [];
  for (const meta of await storage.listPages(project.id)) {
    const page = await storage.getPageById(meta.id);
    if (!page) continue;
    const lines: CosenseLine[] =
      format === 'import'
        ? page.lines.map((l) => l.text)
        : page.lines.map((l) => ({ id: l.id, text: l.text, userId: l.userId, created: l.created, updated: l.updated }));
    pages.push({ id: page.id, title: page.title, created: page.created, updated: page.updated, lines });
  }

  const users = await storage.listUsersForProject(project.id);
  return {
    name: project.name,
    displayName: project.displayName,
    exported: now,
    users: users.map((u) => ({ id: u.id, name: u.name, displayName: u.displayName })),
    pages,
  };
}
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 6: Commit**

```bash
git add src/storage/export.ts test/fixtures/cosense-export.json test/storage/export.test.ts
git commit -m "feat(storage): Cosense 互換エクスポートと round-trip テストを追加"
```

---

### Task 10: CLI（init / import / export / reindex）

CLI はロジックを持たない。
`src/cli/commands.ts` の関数（テスト対象）と、それを argv から呼ぶだけの `src/cli/main.ts`（shebang 付きエントリ、spawn テスト 1 本）に分ける。

**Files:**
- Create: `src/cli/commands.ts`
- Create: `src/cli/main.ts`
- Modify: `package.json`（`bin` を追加）
- Test: `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `openDatabase`（Task 1）、`SqliteStorage`（Task 2〜）、`importCosense`（Task 8）、`exportCosense`（Task 9）
- Produces: `runInit(dataDir) / runImport(dataDir, projectName, file, onConflict) / runExport(dataDir, projectName, format, out) / runReindex(dataDir, projectName)`（すべて `Promise<string>` を返し、失敗は throw）。実行形: `node src/cli/main.ts <command> --data <dir> ...`

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/cli.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExport, runImport, runInit, runReindex } from '../../src/cli/commands.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/cosense-export.json', import.meta.url));
const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'knot-cli-'));

test('init は knot.db と files/ を作る', async () => {
  const dir = tmp();
  const msg = await runInit(dir);
  assert.match(msg, /initialized/);
  assert.ok(existsSync(join(dir, 'knot.db')));
  assert.ok(existsSync(join(dir, 'files')));
});

test('import → export → reindex が通る', async () => {
  const dir = tmp();
  await runInit(dir);
  const imported = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(imported, /3 created/);
  const json = await runExport(dir, 'sandbox', 'full', null);
  const exp = JSON.parse(json) as { name: string; pages: unknown[] };
  assert.equal(exp.name, 'sandbox');
  assert.equal(exp.pages.length, 3);
  const again = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(again, /3 skipped/);
  const reindexed = await runReindex(dir, 'sandbox');
  assert.match(reindexed, /reindexed 3 pages/);
});

test('export --out はファイルに書き、reindex は未知プロジェクトを拒否する', async () => {
  const dir = tmp();
  await runInit(dir);
  await runImport(dir, 'sandbox', FIXTURE, 'skip');
  const outFile = join(dir, 'out.json');
  const msg = await runExport(dir, 'sandbox', 'import', outFile);
  assert.match(msg, /3 pages/);
  const exp = JSON.parse(
    (await import('node:fs')).readFileSync(outFile, 'utf8'),
  ) as { pages: { lines: unknown[] }[] };
  assert.equal(typeof exp.pages[0].lines[0], 'string');
  await assert.rejects(runReindex(dir, 'nope'), /unknown project/);
});

test('CLI 実行ファイルとして通しで動く（spawn）', () => {
  const dir = tmp();
  execFileSync(process.execPath, [MAIN, 'init', '--data', dir], { stdio: 'pipe' });
  execFileSync(process.execPath, [MAIN, 'import', '--data', dir, '--project', 'sandbox', FIXTURE], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [MAIN, 'export', '--data', dir, '--project', 'sandbox'], {
    stdio: 'pipe',
  }).toString();
  assert.equal((JSON.parse(out) as { pages: unknown[] }).pages.length, 3);
  // 未知コマンドは exit code 1
  assert.throws(() => execFileSync(process.execPath, [MAIN, 'bogus', '--data', dir], { stdio: 'pipe' }));
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module .../src/cli/commands.ts`）

- [ ] **Step 3: 実装する**

`src/cli/commands.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../storage/db.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { importCosense } from '../storage/import.ts';
import { exportCosense, type ExportFormat } from '../storage/export.ts';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function openStorage(dataDir: string): SqliteStorage {
  return new SqliteStorage(openDatabase(join(dataDir, 'knot.db')));
}

export async function runInit(dataDir: string): Promise<string> {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const storage = openStorage(dataDir);
  await storage.close();
  return `initialized ${dataDir}`;
}

export async function runImport(
  dataDir: string,
  projectName: string,
  file: string,
  onConflict: 'skip' | 'overwrite',
): Promise<string> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const storage = openStorage(dataDir);
  try {
    const s = await importCosense(storage, data, { projectName, onConflict });
    return `imported: ${s.created} created, ${s.overwritten} overwritten, ${s.skipped} skipped, ${s.users} users`;
  } finally {
    await storage.close();
  }
}

export async function runExport(
  dataDir: string,
  projectName: string,
  format: ExportFormat,
  out: string | null,
): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    const exp = await exportCosense(storage, projectName, format, Math.floor(Date.now() / 1000));
    const json = JSON.stringify(exp, null, 2);
    if (out === null) return json;
    writeFileSync(out, json);
    return `exported ${exp.pages.length} pages to ${out}`;
  } finally {
    await storage.close();
  }
}

export async function runReindex(dataDir: string, projectName: string | null): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    let projectId: string | undefined;
    if (projectName !== null) {
      const project = await storage.getProject(projectName);
      if (!project) throw new CliError(`unknown project: ${projectName}`);
      projectId = project.id;
    }
    const { pages } = await storage.reindex(projectId);
    return `reindexed ${pages} pages`;
  } finally {
    await storage.close();
  }
}
```

`src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CliError, runExport, runImport, runInit, runReindex } from './commands.ts';

const USAGE = `usage:
  knot init    --data <dir>
  knot import  --data <dir> --project <name> [--on-conflict skip|overwrite] <file.json>
  knot export  --data <dir> --project <name> [--format import] [--out <file.json>]
  knot reindex --data <dir> [--project <name>]`;

async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      project: { type: 'string' },
      'on-conflict': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const data = values.data;
  if (command === undefined || data === undefined) throw new CliError(USAGE);
  switch (command) {
    case 'init':
      return runInit(data);
    case 'import': {
      const file = positionals[0];
      if (values.project === undefined || file === undefined) throw new CliError(USAGE);
      const onConflict = values['on-conflict'] ?? 'skip';
      if (onConflict !== 'skip' && onConflict !== 'overwrite') throw new CliError(USAGE);
      return runImport(data, values.project, file, onConflict);
    }
    case 'export': {
      if (values.project === undefined) throw new CliError(USAGE);
      const format = values.format ?? 'full';
      if (format !== 'full' && format !== 'import') throw new CliError(USAGE);
      return runExport(data, values.project, format, values.out ?? null);
    }
    case 'reindex':
      return runReindex(data, values.project ?? null);
    default:
      throw new CliError(USAGE);
  }
}

main(process.argv.slice(2)).then(
  (out) => console.log(out),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
```

`package.json` の `"private": true,` の次の行に追加:

```json
  "bin": { "knot": "src/cli/main.ts" },
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test && npx tsc --noEmit`
Expected: PASS（fail 0）

- [ ] **Step 5: 実 CLI の動作を目視確認する**

Run:

```bash
cd "$(mktemp -d)" && node /path/to/knot/src/cli/main.ts init --data ./data \
  && node /path/to/knot/src/cli/main.ts import --data ./data --project sandbox /path/to/knot/test/fixtures/cosense-export.json \
  && node /path/to/knot/src/cli/main.ts export --data ./data --project sandbox | head -20
```

（`/path/to/knot` はリポジトリ（worktree）の絶対パスに置き換える）
Expected: `initialized ./data`、`imported: 3 created, ...`、JSON の先頭 20 行

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts src/cli/main.ts package.json test/cli/cli.test.ts
git commit -m "feat(cli): init / import / export / reindex コマンドを追加"
```

---

## 完了条件

- `npm test` が全タスクのテストを通す（fail 0）。`npm run typecheck` がエラーなしで終わる。
- フィクスチャの round-trip（インポート → エクスポートで行テキスト・タイムスタンプ・userId・ID が保存）がテストで固定されている。
- すべての書き込み経路（`commit` / `importPage`）が commits テーブルに行を残す。
- links / pages_fts / pages.image が `reindex` だけで再構築できる。
- plan-01 持ち越しの Minor 3 点（progress.md 記載）が Task 0 で解消されている。
- 手元に実際の Cosense エクスポート JSON がある場合の受け入れ確認（任意・手動）:

```bash
node src/cli/main.ts init --data ./data
node src/cli/main.ts import --data ./data --project <name> <実エクスポート.json>
node src/cli/main.ts export --data ./data --project <name> --out roundtrip.json
```

- 計画 03（api-server）が、`Storage` インターフェースと `importCosense` / `exportCosense` だけを使って着手できる。




