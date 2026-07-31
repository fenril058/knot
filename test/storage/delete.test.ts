import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { BadCommitError } from '../../src/storage/types.ts';

const now = 1700000000;

void test('deletePage で deleted が立ち、タイトル解決から消え、commits は残る', async () => {
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

void test('削除後に同タイトルの新ページを作れる', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const oldId = await seedPage(storage, project.id, 'Title', ['x'], now);
  await storage.deletePage(project.id, oldId, 'u', now + 10);
  const newId = await seedPage(storage, project.id, 'Title', ['y'], now + 20);
  assert.notEqual(newId, oldId);
  const page = await storage.getPageByTitle(project.id, 'title');
  assert.equal(page!.id, newId);
});
