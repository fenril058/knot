import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';

const now = 1700000000;

test('getVisit: 未訪問は null', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  assert.equal(await storage.getVisit('u1', pageId), null);
});

test('recordVisit → getVisit: upsert で最新値を返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  await storage.recordVisit('u1', pageId, now, 1);
  assert.deepEqual(await storage.getVisit('u1', pageId), { visited: now, lastSeenVersion: 1 });
  await storage.recordVisit('u1', pageId, now + 10, 3);
  assert.deepEqual(await storage.getVisit('u1', pageId), { visited: now + 10, lastSeenVersion: 3 });
});

test('recordVisit: ユーザーごとに独立', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  await storage.recordVisit('u1', pageId, now, 2);
  assert.equal(await storage.getVisit('u2', pageId), null);
});

test('recordVisit: 遅れて完了した古い訪問で記録を巻き戻さない', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const pageId = await seedPage(storage, project.id, 'A', ['x'], now);
  await storage.recordVisit('u1', pageId, now + 10, 3);
  await storage.recordVisit('u1', pageId, now, 1);
  assert.deepEqual(await storage.getVisit('u1', pageId), { visited: now + 10, lastSeenVersion: 3 });
});
