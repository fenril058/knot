import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { BadCommitError } from '../../src/storage/types.ts';

const now = 1700000000;

void test('deletePage で deleted が立ち、タイトル解決から消え、commits は残る', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Doomed', ['a', 'b'], now);
  const result = await storage.deletePage({
    projectId: project.id, pageId, baseVersion: 1, actorId: 'u', now: now + 10,
  });
  assert.deepEqual(result, { kind: 'applied', version: 2 });
  assert.equal(await storage.getPageByTitle(project.id, 'doomed'), null);
  const page = await storage.getPageById(pageId);
  assert.equal(page!.deleted, true);
  assert.deepEqual(page!.lines, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM commits WHERE page_id = ?').get(pageId)?.n, 2);
  // 二重削除は BadCommitError
  await assert.rejects(storage.deletePage({
    projectId: project.id, pageId, baseVersion: 2, actorId: 'u', now: now + 20,
  }), BadCommitError);
});

void test('stale delete は current page、commit、links、search index を変更しない', async () => {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Target', ['target body'], now);
  const pageId = await seedPage(storage, project.id, 'Doomed', ['[Target] needle version 1'], now + 1);
  const version1 = await storage.getPageById(pageId);
  const updated = await storage.commit({
    projectId: project.id,
    pageId,
    commitId: 'doomed-version-2',
    baseVersion: 1,
    ops: [{ type: 'update', id: version1!.lines[1]!.id, text: '[Target] needle version 2' }],
    actorId: 'u',
    now: now + 2,
  });
  assert.equal(updated.kind, 'applied');
  const commitsBefore = db.prepare('SELECT count(*) AS n FROM commits WHERE page_id = ?').get(pageId)?.n;
  const linksBefore = db.prepare('SELECT count(*) AS n FROM links WHERE source_page_id = ?').get(pageId)?.n;
  const searchRowsBefore = db.prepare('SELECT count(*) AS n FROM pages_fts WHERE page_id = ?').get(pageId)?.n;
  assert.equal(commitsBefore, 2);
  assert.equal(linksBefore, 1);
  assert.equal(searchRowsBefore, 1);
  assert.deepEqual((await storage.search(project.id, parseSearchQuery('needle'))).map((hit) => hit.pageId), [pageId]);

  const stale = await storage.deletePage({
    projectId: project.id,
    pageId,
    baseVersion: 1,
    actorId: 'u',
    now: now + 3,
  });

  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.kind === 'conflict' ? stale.page.version : 0, 2);
  assert.equal(stale.kind === 'conflict' ? stale.page.lines[1]?.text : '', '[Target] needle version 2');
  const current = await storage.getPageById(pageId);
  assert.equal(current!.deleted, false);
  assert.equal(current!.version, 2);
  assert.equal(current!.lines[1]!.text, '[Target] needle version 2');
  assert.equal(db.prepare('SELECT count(*) AS n FROM commits WHERE page_id = ?').get(pageId)?.n, commitsBefore);
  assert.equal(db.prepare('SELECT count(*) AS n FROM links WHERE source_page_id = ?').get(pageId)?.n, linksBefore);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages_fts WHERE page_id = ?').get(pageId)?.n, searchRowsBefore);
  assert.deepEqual((await storage.search(project.id, parseSearchQuery('needle'))).map((hit) => hit.pageId), [pageId]);
});

void test('削除後に同タイトルの新ページを作れる', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const oldId = await seedPage(storage, project.id, 'Title', ['x'], now);
  await storage.deletePage({
    projectId: project.id, pageId: oldId, baseVersion: 1, actorId: 'u', now: now + 10,
  });
  const newId = await seedPage(storage, project.id, 'Title', ['y'], now + 20);
  assert.notEqual(newId, oldId);
  const page = await storage.getPageByTitle(project.id, 'title');
  assert.equal(page!.id, newId);
});
