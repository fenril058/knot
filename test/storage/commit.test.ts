import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { BadCommitError } from '../../src/storage/types.ts';
import { opsHash } from '../../src/storage/hash.ts';
import type { LineOp } from '../../src/core/ops.ts';

void test('opsHash はキー順に依存しない決定的ハッシュ', () => {
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

void test('最初のコミットでページが作られ version 1 になる', async () => {
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

void test('逐次コミットで version が増え、行順と ord が ops 適用順に決まる', async () => {
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ords = (db.prepare('SELECT ord FROM lines WHERE page_id = ? ORDER BY ord').all('pg1') as { ord: number }[])
    .map((r2) => r2.ord);
  assert.deepEqual(ords, [0, 1, 2]);
  await storage.close();
});

void test('先頭行の変更はタイトル変更になり title_history に残る', async () => {
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const hist = db
    .prepare('SELECT old_title, old_title_lc, started, ended FROM title_history WHERE page_id = ?')
    .all('pg1') as { old_title: string; old_title_lc: string; started: number; ended: number }[];
  assert.equal(hist.length, 1);
  assert.equal(hist[0].old_title, 'Old Title');
  assert.equal(hist[0].old_title_lc, 'old_title');
  assert.equal(hist[0].ended, 3000);
  await storage.close();
});

void test('_head への insert による先頭行の入れ替えもタイトル変更になる', async () => {
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

void test('全行 delete でページが削除され、commits は残る', async () => {
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const row = db.prepare('SELECT deleted, title FROM pages WHERE id = ?').get('pg1') as {
    deleted: number; title: string;
  };
  assert.equal(row.deleted, 1);
  assert.equal(row.title, 'T');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const commits = (db.prepare('SELECT count(*) AS c FROM commits WHERE page_id = ?').get('pg1') as { c: number }).c;
  assert.equal(commits, 2);
  await storage.close();
});

void test('baseVersion 不一致は conflict と最新スナップショットを返す', async () => {
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

void test('タイトルの一意制約違反はコミット全体が conflict になる', async () => {
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

void test('不正 ops は BadCommitError で、コミット全体がロールバックされる', async () => {
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

void test('存在しないページ・別プロジェクトのページ・削除済みページへのコミットは BadCommitError', async () => {
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

void test('新規作成コミットの結果が空になるのは BadCommitError（生まれつき削除済みページを作らない）', async () => {
  const { storage, project } = await setup();
  await assert.rejects(
    storage.commit({
      projectId: project.id, pageId: 'pgX', commitId: 'cx', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'x1', after: '_head', text: 'T' },
        { type: 'delete', id: 'x1' },
      ],
      userId: 'u1', now: 2000,
    }),
    BadCommitError,
  );
  assert.equal(await storage.getPageById('pgX'), null);
  await storage.close();
});
