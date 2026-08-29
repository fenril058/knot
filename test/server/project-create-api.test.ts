import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

async function setup() {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  return { s, cookie };
}

void test('POST /api/knot/projects/:project で空プロジェクトを作れる', async () => {
  const { s, cookie } = await setup();
  const res = await s.request('/api/knot/projects/newproj', { method: 'POST' }, cookie);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'newproj');
  assert.equal(body.created, true);
});

void test('POST /api/knot/projects/:project は不正・予約済み・長すぎる名前を拒否する', async () => {
  const { s, cookie } = await setup();

  for (const name of ['bad_NAME!', 'api', 'a'.repeat(65)]) {
    const res = await s.request(`/api/knot/projects/${name}`, { method: 'POST' }, cookie);
    assert.equal(res.status, 400, name);
    assert.equal((await res.json()).error, 'bad_request');
  }
  assert.deepEqual(await s.storage.listProjects(), []);
});

void test('POST /api/knot/projects/:project は同名への再 POST を成功扱いのまま区別する', async () => {
  const { s, cookie } = await setup();
  const existing = await s.storage.ensureProject('existing', s.clock.t);

  const res = await s.request('/api/knot/projects/existing', { method: 'POST' }, cookie);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: existing.id,
    name: existing.name,
    displayName: existing.displayName,
    created: false,
  });
  assert.equal((await s.storage.listProjects()).length, 1);
});

void test('POST /api/knot/projects/:project は認証と X-Knot-Client header を要求する', async () => {
  const { s } = await setup();

  const withoutHeader = await s.app.request('/api/knot/projects/proj', { method: 'POST' });
  assert.equal(withoutHeader.status, 403);
  assert.equal((await withoutHeader.json()).error, 'forbidden');

  const withoutSession = await s.app.request('/api/knot/projects/proj', {
    method: 'POST',
    headers: { 'X-Knot-Client': 'test' },
  });
  assert.equal(withoutSession.status, 401);
  assert.equal((await withoutSession.json()).error, 'unauthorized');
  assert.deepEqual(await s.storage.listProjects(), []);
});
