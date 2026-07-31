import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('search/query が Cosense 形状で返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Hit Page', ['this line has needle inside'], s.clock.t);
  await seedPage(s.storage, project.id, 'Other', ['nothing here'], s.clock.t + 1);
  const res = await s.request('/api/pages/proj/search/query?q=needle', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projectName, 'proj');
  assert.equal(body.searchQuery, 'needle');
  assert.deepEqual(body.query, { words: ['needle'], excludes: [] });
  assert.equal(body.count, 1);
  assert.equal(body.existsExactTitleMatch, false);
  assert.equal(body.pages[0].title, 'Hit Page');
  assert.deepEqual(body.pages[0].lines, ['this line has needle inside']);
  assert.equal((await s.request('/api/pages/proj/search/query', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj/search/query?q=', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj/search/query?q=%20%20', {}, cookie)).status, 400);
});

void test('existsExactTitleMatch はタイトル lc 一致で true', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Needle', ['needle body'], s.clock.t);
  const res = await s.request('/api/pages/proj/search/query?q=needle', {}, cookie);
  const body = await res.json();
  assert.equal(body.existsExactTitleMatch, true);
});

void test('/api/code はコードブロックを返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Code Page', [
    'code:sample.js',
    ' const a = 1;',
    ' const b = 2;',
    'between',
    'code:sample.js',
    ' const c = 3;',
    'code:other.txt',
    ' unrelated',
  ], s.clock.t);
  const res = await s.request('/api/code/proj/Code%20Page/sample.js', {}, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /^text\/plain/);
  assert.equal(await res.text(), 'const a = 1;\nconst b = 2;\nconst c = 3;');
  assert.equal((await s.request('/api/code/proj/Code%20Page/nope.js', {}, cookie)).status, 404);
  assert.equal((await s.request('/api/code/proj/None/x.js', {}, cookie)).status, 404);
});
