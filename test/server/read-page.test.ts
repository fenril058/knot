import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

test('GET /api/pages/:project/:title が lines / links / relatedPages を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Home', ['see [Sub Page] and [Red]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Sub Page', ['back to [Home]'], s.clock.t + 1);
  const res = await s.request('/api/pages/proj/Home', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'Home');
  assert.equal(body.persistent, true);
  assert.equal(typeof body.version, 'number'); // knot 拡張
  assert.equal(body.lines[0].text, 'Home');
  assert.deepEqual(body.links.sort(), ['Red', 'Sub Page']); // 前方リンクの原文（赤リンク含む）
  assert.deepEqual(body.relatedPages.links1hop.map((p: { title: string }) => p.title), ['Sub Page']);
  assert.equal(body.relatedPages.hasBackLinksOrIcons, true);
  assert.equal(body.linked, 1); // Sub Page からの被リンク
  assert.equal((await s.request('/api/pages/proj/None', {}, cookie)).status, 404);
});

test('GET /api/pages/:project/search/titles', async () => {
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
