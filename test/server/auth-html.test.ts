import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('未ログインで GET /:project は /login へ 302 リダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('未ログインで API は 401 JSON のまま', async () => {
  const s = await makeServer();
  const res = await s.request('/api/pages/proj');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('GET /login は未ログインでも 200', async () => {
  const s = await makeServer();
  const res = await s.request('/login');
  assert.equal(res.status, 200);
});
