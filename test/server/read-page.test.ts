import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('GET /api/pages/:project/:title が lines / links / relatedPages を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await s.storage.upsertDisplayUser({ id: 'u', name: 'editor', displayName: 'Editor' }, s.clock.t);
  const homeId = await seedPage(s.storage, project.id, 'Home', ['see [Sub Page] and [Red]'], s.clock.t);
  const subPageId = await seedPage(s.storage, project.id, 'Sub Page', ['back to [Home]'], s.clock.t + 1);
  await s.storage.recordVisit('u1', homeId, s.clock.t + 10, 1);
  await s.storage.recordVisit('u1', homeId, s.clock.t + 20, 1);
  await s.storage.recordVisit('u2', subPageId, s.clock.t + 15, 1);
  const res = await s.request('/api/pages/proj/Home', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'Home');
  assert.equal(body.persistent, true);
  assert.deepEqual([body.user, body.lastUpdateUser], [
    { id: 'u', name: 'editor', displayName: 'Editor' },
    { id: 'u', name: 'editor', displayName: 'Editor' },
  ]);
  assert.equal(typeof body.version, 'number'); // knot 拡張
  assert.equal(body.lines[0].text, 'Home');
  assert.deepEqual(body.links.toSorted(), ['Red', 'Sub Page']); // 前方リンクの原文（空リンク含む）
  assert.deepEqual(body.relatedPages.links1hop.map((p: { title: string }) => p.title), ['Sub Page']);
  assert.equal(body.relatedPages.hasBackLinksOrIcons, true);
  assert.equal(body.linked, 1); // Sub Page からの被リンク
  assert.equal(body.views, 2);
  assert.equal(body.accessed, s.clock.t + 20);
  assert.equal(body.relatedPages.links1hop[0].accessed, s.clock.t + 15);
  assert.equal((await s.request('/api/pages/proj/None', {}, cookie)).status, 404);
});

void test('GET /api/pages/:project/search/titles', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Page One', ['[Foo Bar]'], s.clock.t);
  const res = await s.request('/api/pages/proj/search/titles', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, [
    { id: body[0].id, title: 'Page One', hasIcon: false, updated: body[0].updated, links: ['Foo Bar'], image: null },
  ]);
});
