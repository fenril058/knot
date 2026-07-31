import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

void test('未ログインで GET /:project は next 付きで /login へ 302 リダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fproj');
});

void test('クエリ付きパスへの未ログインアクセスは next にクエリごと含める', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj?skip=10&limit=5');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fproj%3Fskip%3D10%26limit%3D5');
});

void test('未ログインで API は 401 JSON のまま', async () => {
  const s = await makeServer();
  const res = await s.request('/api/pages/proj');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

void test('GET /login は未ログインでも 200', async () => {
  const s = await makeServer();
  const res = await s.request('/login');
  assert.equal(res.status, 200);
});
