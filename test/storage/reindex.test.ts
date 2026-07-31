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

void test('reindex が links / fts / image を lines から再構築する', async () => {
  const { db, storage } = await setup();
  const result = await storage.reindex();
  assert.equal(result.pages, 1);
  const targets = (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all('pg1') as {
      target_title_lc: string;
    }[]
  ).map((r) => r.target_title_lc);
  assert.deepEqual(targets, ['リンク先']);
  assert.equal(db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?').all('"リンク先"').length, 1);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const image = (db.prepare('SELECT image FROM pages WHERE id = ?').get('pg1') as { image: string | null }).image;
  assert.equal(image, 'https://gyazo.com/img1');
  await storage.close();
});

void test('reindex は削除済みページの残骸も掃除する', async () => {
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  assert.equal((db.prepare('SELECT count(*) AS c FROM links WHERE source_page_id = ?').get('pg1') as { c: number }).c, 0);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  assert.equal((db.prepare('SELECT count(*) AS c FROM pages_fts WHERE page_id = ?').get('pg1') as { c: number }).c, 0);
  await storage.close();
});

void test('projectId を指定すると、そのプロジェクトのページだけ数える', async () => {
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  assert.equal((db.prepare('SELECT count(*) AS c FROM links WHERE source_page_id = ?').get('pg1') as { c: number }).c, 0);
  await storage.close();
});
