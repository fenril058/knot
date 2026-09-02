import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('DELETE でページが消え、以後の GET は 404', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['x'], s.clock.t);
  const res = await s.request('/api/knot/pages/proj/Doomed', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, baseVersion: 1 }),
  }, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal((await s.request('/api/pages/proj/Doomed', {}, cookie)).status, 404);
  const stale = await s.request('/api/knot/pages/proj/Doomed', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, baseVersion: 1 }),
  }, cookie);
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, pageId);
  assert.equal(conflict.page.version, 2);
});

void test('stale な baseVersion の DELETE は 409 になり最新ページを残す', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['version 1'], s.clock.t);
  const version1 = await s.storage.getPageById(pageId);

  const updated = await s.storage.commit({
    projectId: project.id,
    pageId,
    commitId: ulid(s.clock.t * 1000 + 1),
    baseVersion: 1,
    ops: [{ type: 'update', id: version1!.lines[1]!.id, text: 'version 2' }],
    actorId: 'u',
    now: s.clock.t + 1,
  });
  assert.equal(updated.kind, 'applied');

  const stale = await s.request('/api/knot/pages/proj/Doomed', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId, baseVersion: 1 }),
  }, cookie);

  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.version, 2);
  assert.deepEqual(conflict.page.lines.map((line: { text: string }) => line.text), ['Doomed', 'version 2']);
  const current = await s.storage.getPageById(pageId);
  assert.equal(current!.deleted, false);
  assert.equal(current!.version, 2);
  assert.deepEqual(current!.lines.map((line) => line.text), ['Doomed', 'version 2']);
});

void test('旧タイトルの再利用後も pageId で元ページを追跡し、別ページを削除しない', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const originalId = await seedPage(s.storage, project.id, 'Old', ['original'], s.clock.t);
  const renamed = await s.storage.renamePage({
    projectId: project.id,
    pageId: originalId,
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: false,
    actorId: 'u',
    now: s.clock.t + 1,
  });
  assert.equal(renamed.kind, 'applied');
  const replacementId = await seedPage(s.storage, project.id, 'Old', ['replacement'], s.clock.t + 2);

  const stale = await s.request('/api/knot/pages/proj/Old', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageId: originalId, baseVersion: 1 }),
  }, cookie);

  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, originalId);
  assert.equal(conflict.page.title, 'New');
  assert.equal(conflict.page.version, 2);
  const original = await s.storage.getPageById(originalId);
  assert.equal(original!.deleted, false);
  assert.equal(original!.version, 2);
  const replacement = await s.storage.getPageById(replacementId);
  assert.equal(replacement!.deleted, false);
  assert.equal(replacement!.version, 1);
  assert.deepEqual(replacement!.lines.map((line) => line.text), ['Old', 'replacement']);
});

void test('DELETE は非負整数の baseVersion を必須にする', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['keep me'], s.clock.t);

  for (const body of [
    undefined,
    {},
    { baseVersion: 1 },
    { pageId },
    { pageId: '', baseVersion: 1 },
    { pageId: 1, baseVersion: 1 },
    { pageId, baseVersion: '1' },
    { pageId, baseVersion: -1 },
    { pageId, baseVersion: 1.5 },
  ]) {
    const response = await s.request('/api/knot/pages/proj/Doomed', {
      method: 'DELETE',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, cookie);
    assert.equal(response.status, 400);
  }

  const current = await s.storage.getPageById(pageId);
  assert.equal(current!.deleted, false);
  assert.equal(current!.version, 1);
});

void test('存在しない project は DELETE body より先に 404 になる', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');

  const response = await s.request('/api/knot/pages/missing/Doomed', {
    method: 'DELETE',
  }, cookie);

  assert.equal(response.status, 404);
});
