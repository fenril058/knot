import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { StorageError } from '../../src/storage/types.ts';

void test('ensureProject は無ければ作り、あれば同じものを返す', async () => {
  const { storage } = makeStorage();
  const a = await storage.ensureProject('wiki', 100);
  const b = await storage.ensureProject('wiki', 200);
  assert.equal(a.id, b.id);
  assert.equal(b.created, 100);
  assert.equal(await storage.getProject('nope'), null);
  await storage.close();
});

void test('createProject は作成と既存を区別し、ensureProject と同じ validation を使う', async () => {
  const { storage } = makeStorage();

  const created = await storage.createProject('wiki', 100);
  assert.equal(created.kind, 'created');
  const existing = await storage.createProject('wiki', 200);
  assert.equal(existing.kind, 'existing');
  assert.equal(existing.project.id, created.project.id);
  await assert.rejects(storage.createProject('Bad Name', 300), StorageError);
  await assert.rejects(storage.ensureProject('Bad Name', 300), StorageError);
  await storage.close();
});

void test('不正・予約語のプロジェクト名を拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(storage.ensureProject('Bad Name', 1), StorageError);
  await assert.rejects(storage.ensureProject('api', 1), StorageError);
  await storage.close();
});

void test('新規プロジェクト名は64文字を受理し、65文字を拒否する', async () => {
  const { storage } = makeStorage();
  const accepted = 'a'.repeat(64);
  const rejected = 'a'.repeat(65);

  assert.equal((await storage.ensureProject(accepted, 1)).name, accepted);
  await assert.rejects(storage.ensureProject(rejected, 1), StorageError);
  await storage.close();
});

void test('既存の65文字のプロジェクトは引き続き ensure できる', async () => {
  const { db, storage } = makeStorage();
  const name = 'a'.repeat(65);
  db.prepare(
    'INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)',
  ).run('legacy-project', name, name, 1, 1);

  assert.equal((await storage.ensureProject(name, 2)).id, 'legacy-project');
  await storage.close();
});

void test('既存行でも不正文字と予約語のプロジェクト名を拒否する', async () => {
  const { db, storage } = makeStorage();
  const insert = db.prepare(
    'INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('legacy-invalid', 'Bad Name', 'Bad Name', 1, 1);
  insert.run('legacy-reserved', 'api', 'api', 1, 1);

  await assert.rejects(storage.ensureProject('Bad Name', 2), StorageError);
  await assert.rejects(storage.ensureProject('api', 2), StorageError);
  await storage.close();
});

void test('listProjects は name 昇順ですべてのプロジェクトを返す', async () => {
  const { storage } = makeStorage();
  await storage.ensureProject('zeta', 100);
  await storage.ensureProject('alpha', 200);

  const projects = await storage.listProjects();

  assert.deepEqual(projects.map((project) => project.name), ['alpha', 'zeta']);
  await storage.close();
});

void test('upsertActor は同名でも ID が異なる Actor を統合しない', async () => {
  const { db, storage } = makeStorage();
  const first = await storage.upsertActor({ id: 'u1', name: 'alice', displayName: 'Alice' }, 1);
  const second = await storage.upsertActor({ id: 'u2', name: 'alice', displayName: 'Alice2' }, 2);
  assert.equal(first, 'u1');
  assert.equal(second, 'u2');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const count = (db.prepare('SELECT count(*) AS c FROM actors').get() as { c: number }).c;
  assert.equal(count, 2);
  await storage.close();
});

void test('getPageAuthors は最古と最新のコミットのユーザーを返す', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1);
  await storage.upsertActor({ id: 'creator', name: 'alice', displayName: 'Alice' }, 1);
  await storage.upsertActor({ id: 'editor', name: 'bob', displayName: 'Bob' }, 2);
  db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES ('page', ?, 'Page', 'page', 2, 0, 0, NULL, 1, 2)`,
  ).run(project.id);
  const insertCommit = db.prepare(
    `INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash)
     VALUES (?, 'page', ?, ?, ?, ?, '[]', ?)`,
  );
  insertCommit.run('commit-1', 0, 1, 'creator', 1, 'hash-1');
  insertCommit.run('commit-2', 1, 2, 'editor', 2, 'hash-2');

  assert.deepEqual(await storage.getPageAuthors('page'), {
    user: { id: 'creator', name: 'alice', displayName: 'Alice' },
    lastUpdateUser: { id: 'editor', name: 'bob', displayName: 'Bob' },
  });
  await storage.close();
});

void test('getPageByTitle / listPages は削除済みページを除外する', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 100);
  const insertPage = db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES (?, ?, ?, ?, 1, 0, ?, NULL, 10, ?)`,
  );
  insertPage.run('pg1', project.id, 'Foo Bar', 'foo_bar', 0, 30);
  insertPage.run('pg2', project.id, 'Gone', 'gone', 1, 20);
  await storage.upsertActor({ id: 'u1', name: 'u1', displayName: 'u1' }, 10);
  db.prepare(
    `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id)
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

void test('listKnownPages は未削除ページの titleLc・title・image だけを返す', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 100);
  const insert = db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, 10, 10)`,
  );
  insert.run('p1', project.id, 'Alpha Page', 'alpha_page', 0, 'https://example.com/a.png');
  insert.run('p2', project.id, 'Gone', 'gone', 1, null);

  const pages = await storage.listKnownPages(project.id);

  assert.deepEqual(pages, [{ titleLc: 'alpha_page', title: 'Alpha Page', image: 'https://example.com/a.png' }]);
  await storage.close();
});
