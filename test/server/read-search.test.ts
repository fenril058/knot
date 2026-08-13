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

void test('existsExactTitleMatch は引用フレーズと同じタイトルで true', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Exact Phrase', ['Exact Phrase'], s.clock.t);

  const res = await s.request('/api/pages/proj/search/query?q=%22Exact%20Phrase%22', {}, cookie);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).existsExactTitleMatch, true);
});

void test('search/query は検索語数とクエリ長の上限を検査する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const maximumTerms = Array.from({ length: 32 }, (_, index) => `w${index}`).join(' ');
  const tooManyTerms = `${maximumTerms} overflow`;
  assert.equal((await s.request(
    `/api/pages/proj/search/query?q=${encodeURIComponent(maximumTerms)}`,
    {},
    cookie,
  )).status, 200);
  assert.equal((await s.request(
    `/api/pages/proj/search/query?q=${encodeURIComponent(tooManyTerms)}`,
    {},
    cookie,
  )).status, 400);

  const maximumLength = 'x'.repeat(1_000);
  assert.equal((await s.request(
    `/api/pages/proj/search/query?q=${maximumLength}`,
    {},
    cookie,
  )).status, 200);
  assert.equal((await s.request(
    `/api/pages/proj/search/query?q=${maximumLength}x`,
    {},
    cookie,
  )).status, 400);
});

void test('search/query は空白区切りを AND、先頭 - を除外、引用符内をフレーズとして扱う', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Together', ['alpha beta'], s.clock.t);
  await seedPage(s.storage, project.id, 'Split', ['alpha', 'beta'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Excluded', ['alpha beta gamma'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Only Alpha', ['alpha'], s.clock.t + 3);

  const andResponse = await s.request(
    '/api/pages/proj/search/query?q=alpha%20beta%20-gamma',
    {},
    cookie,
  );
  assert.equal(andResponse.status, 200);
  const andBody = await andResponse.json();
  assert.deepEqual(andBody.query, { words: ['alpha', 'beta'], excludes: ['gamma'] });
  assert.deepEqual(andBody.pages.map((page: { title: string }) => page.title).toSorted(), ['Split', 'Together']);
  assert.deepEqual(andBody.pages.find((page: { title: string }) => page.title === 'Split').lines, ['alpha', 'beta']);
  assert.ok(andBody.pages.every((page: { words: string[] }) =>
    page.words.length === 2 && page.words[0] === 'alpha' && page.words[1] === 'beta'));

  const phraseResponse = await s.request(
    '/api/pages/proj/search/query?q=%22alpha%20beta%22%20-gamma',
    {},
    cookie,
  );
  assert.equal(phraseResponse.status, 200);
  const phraseBody = await phraseResponse.json();
  assert.deepEqual(phraseBody.query, { words: ['alpha beta'], excludes: ['gamma'] });
  assert.deepEqual(phraseBody.pages.map((page: { title: string }) => page.title), ['Together']);
});

void test('search/query は語中の引用符を検索語に保持する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Literal Quote', ['alpha"beta'], s.clock.t);

  const response = await s.request('/api/pages/proj/search/query?q=alpha%22beta', {}, cookie);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.query, { words: ['alpha"beta'], excludes: [] });
  assert.deepEqual(body.pages.map((page: { title: string }) => page.title), ['Literal Quote']);
});

void test('search/query は空の引用フレーズを必須語として扱い 0 件を返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['alpha'], s.clock.t);

  const response = await s.request('/api/pages/proj/search/query?q=alpha%20%22%22', {}, cookie);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.query, { words: ['alpha', ''], excludes: [] });
  assert.equal(body.count, 0);
  assert.deepEqual(body.pages, []);
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
