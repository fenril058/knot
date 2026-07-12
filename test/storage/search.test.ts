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
