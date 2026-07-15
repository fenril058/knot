import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function setup() {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const rename = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  return { s, project, cookie, rename };
}

test('rename がタイトルを変え、rewritten を返す', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Old Name', ['content'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old Name]'], s.clock.t + 1);
  const res = await rename('Old Name', { baseVersion: 1, newTitle: 'New Name', rewriteLinks: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'New Name');
  assert.deepEqual(body.rewritten, [{ id: srcId, title: 'Src', version: 2 }]);
});

test('rewriteLinks 省略時は書き換えない', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old]'], s.clock.t + 1);
  const res = await rename('Old', { baseVersion: 1, newTitle: 'New' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).rewritten, []);
  const src = await s.storage.getPageById(srcId);
  assert.equal(src!.lines[1].text, '[Old]');
});

test('rewriteLinks が boolean でなければ 400', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t);
  const res = await rename('Old', { baseVersion: 1, newTitle: 'New', rewriteLinks: 'true' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request', message: 'rewriteLinks must be a boolean' });
});

test('占有タイトルへの rename は 409 reason title、baseVersion 不一致は 409 reason version', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Taken', ['x'], s.clock.t);
  await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t + 1);
  const res = await rename('Old', { baseVersion: 1, newTitle: 'Taken' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'title');
  assert.equal(body.page.title, 'Taken');
  const stale = await rename('Old', { baseVersion: 9, newTitle: 'Fresh' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).reason, 'version');
});

test('不正な body は 400、不在ページは 404', async () => {
  const { rename } = await setup();
  assert.equal((await rename('Ghost', { baseVersion: 1, newTitle: 'X' })).status, 404);
  const { s, project, rename: rename2 } = await setup();
  await seedPage(s.storage, project.id, 'P', ['x'], s.clock.t);
  assert.equal((await rename2('P', { baseVersion: 1, newTitle: '' })).status, 400);
  assert.equal((await rename2('P', { baseVersion: 1 })).status, 400);
  assert.equal((await rename2('P', { newTitle: 'X' })).status, 400);
  assert.equal((await rename2('P', { baseVersion: 1, newTitle: 'P' })).status, 400);
});
