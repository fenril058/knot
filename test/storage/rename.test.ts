import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';
import { BadCommitError } from '../../src/storage/types.ts';

const now = 1700000000;

void test('rename はタイトル行の update コミットに帰着する', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['body'], now);
  const result = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'New', rewriteLinks: false, actorId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  const page = await storage.getPageById(pageId);
  assert.equal(page!.title, 'New');
  assert.equal(page!.version, 2);
  assert.equal(page!.lines[0]!.text, 'New');
  assert.equal(await storage.getPageByTitle(project.id, 'old'), null);
});

void test('rewriteLinks: true でリンク元の本文が書き換わり、リンク索引も更新される', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const targetId = await seedPage(storage, project.id, 'Old Name', ['content'], now);
  const srcId = await seedPage(storage, project.id, 'Src', ['see [Old Name] and #old_name'], now + 1);
  const untouchedId = await seedPage(storage, project.id, 'Untouched', ['no links'], now + 2);
  const result = await storage.renamePage({
    projectId: project.id, pageId: targetId, baseVersion: 1, newTitle: 'New Name', rewriteLinks: true, actorId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  assert.deepEqual(result.kind === 'applied' ? result.rewritten.map((r) => r.pageId) : [], [srcId]);
  const src = await storage.getPageById(srcId);
  assert.equal(src!.lines[1]!.text, 'see [New Name] and [New Name]');
  assert.equal(src!.version, 2);
  const untouched = await storage.getPageById(untouchedId);
  assert.equal(untouched!.version, 1);
  const rel = await storage.getRelatedPages(project.id, targetId, 'new_name');
  assert.equal(rel.hasBackLinks, true);
});

void test('新タイトルの占有は conflict で全体が失敗する（リンク元も書き換わらない）', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Taken', ['x'], now);
  const targetId = await seedPage(storage, project.id, 'Old', ['x'], now + 1);
  const srcId = await seedPage(storage, project.id, 'Src', ['[Old]'], now + 2);
  const result = await storage.renamePage({
    projectId: project.id, pageId: targetId, baseVersion: 1, newTitle: 'Taken', rewriteLinks: true, actorId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'conflict');
  assert.equal(result.kind === 'conflict' ? result.reason : '', 'title');
  assert.equal(result.kind === 'conflict' ? result.page.title : '', 'Taken');
  const src = await storage.getPageById(srcId);
  assert.equal(src!.lines[1]!.text, '[Old]');
});

void test('大文字小文字だけの変更（同じ lc）は衝突しない', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'name', ['x'], now);
  const result = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'Name', rewriteLinks: false, actorId: 'u', now: now + 10,
  });
  assert.equal(result.kind, 'applied');
  const page = await storage.getPageById(pageId);
  assert.equal(page!.title, 'Name');
});

void test('baseVersion 不一致は conflict reason version で最新を返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['x'], now);
  await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'Mid', rewriteLinks: false, actorId: 'u', now: now + 5,
  });
  const stale = await storage.renamePage({
    projectId: project.id, pageId, baseVersion: 1, newTitle: 'New', rewriteLinks: false, actorId: 'u', now: now + 10,
  });
  assert.equal(stale.kind, 'conflict');
  assert.equal(stale.kind === 'conflict' ? stale.reason : '', 'version');
  assert.equal(stale.kind === 'conflict' ? stale.page.title : '', 'Mid');
});

void test('空タイトルと同一タイトルは BadCommitError', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'Old', ['x'], now);
  const base = { projectId: project.id, pageId, baseVersion: 1, rewriteLinks: false, actorId: 'u', now: now + 10 };
  await assert.rejects(storage.renamePage({ ...base, newTitle: '' }), BadCommitError);
  await assert.rejects(storage.renamePage({ ...base, newTitle: 'Old' }), BadCommitError);
});
