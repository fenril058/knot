import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('DELETE でページが消え、以後の GET は 404', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Doomed', ['x'], s.clock.t);
  const res = await s.request('/api/knot/pages/proj/Doomed', { method: 'DELETE' }, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal((await s.request('/api/pages/proj/Doomed', {}, cookie)).status, 404);
  assert.equal((await s.request('/api/knot/pages/proj/Doomed', { method: 'DELETE' }, cookie)).status, 404);
});
