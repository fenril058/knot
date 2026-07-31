import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { makeStorage } from '../helpers/storage.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  return { db, storage, project };
}

void test('コミットで links にリンク先 title_lc が入る', async () => {
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

void test('pages.image は最初の画像 URL になり、無ければ NULL', async () => {
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

void test('コミットで pages_fts が更新され、タイトル変更にも追随する', async () => {
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

void test('ページ削除で links と fts が消え image が NULL になる', async () => {
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

void test('links テーブルに原文タイトルが保存される', async () => {
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
