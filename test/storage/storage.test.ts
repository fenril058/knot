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
