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
  await seedPage(s.storage, project.id, 'Doomed', ['x'], s.clock.t);
  const res = await s.request('/api/knot/pages/proj/Doomed', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 1 }),
  }, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal((await s.request('/api/pages/proj/Doomed', {}, cookie)).status, 404);
  assert.equal((await s.request('/api/knot/pages/proj/Doomed', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseVersion: 2 }),
  }, cookie)).status, 404);
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
    body: JSON.stringify({ baseVersion: 1 }),
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

void test('DELETE は非負整数の baseVersion を必須にする', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['keep me'], s.clock.t);

  for (const body of [undefined, {}, { baseVersion: '1' }, { baseVersion: -1 }, { baseVersion: 1.5 }]) {
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
