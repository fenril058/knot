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
