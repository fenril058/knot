import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

test('GET /api/pages/v2/:project/:title は v1 と同一 JSON を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Home', ['see [Sub Page]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Sub Page', ['back to [Home]'], s.clock.t + 1);

  const v1 = await s.request('/api/pages/proj/Home', {}, cookie);
  const v2 = await s.request('/api/pages/v2/proj/Home', {}, cookie);

  assert.equal(v1.status, 200);
  assert.equal(v2.status, 200);
  assert.deepEqual(await v2.json(), await v1.json());
});

test('GET /api/pages/v2/:project/:title は未知ページに 404 を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/api/pages/v2/proj/None', {}, cookie);

  assert.equal(res.status, 404);
});

test('GET /api/pages/v2/:project/:title は未認証に 401 を返す', async () => {
  const s = await makeServer();

  const res = await s.request('/api/pages/v2/proj/Home');

  assert.equal(res.status, 401);
});
