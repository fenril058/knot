import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

// 全文検索の結果ページ（#247）。Cosense の /:project/search/page と同じ URL で、語を含むページを
// タイトルと語を含む行の抜粋で並べ、語を太字・黄色の背景（.search-matched）で示す。

void test('GET /:project/search/page: 語を含むページだけを、語を示したタイトルと行の抜粋で並べる', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['the needle is here', 'other line'], s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['nothing to find'], s.clock.t);

  const res = await s.request('/proj/search/page?q=needle', {}, cookie);

  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<li class="search-result"><a href="\/proj\/Alpha">/);
  assert.match(body, /<span>the <strong class="search-matched">needle<\/strong> is here<\/span>/);
  assert.doesNotMatch(body, /other line/);
  assert.doesNotMatch(body, /href="\/proj\/Beta"/);
  assert.match(body, /<span class="search-count">\(1\)<\/span>/);
  // バーの検索欄には検索した語が入っていて、767px 以下でも開いている。
  assert.match(body, /<nav class="page-nav search-open">/);
  assert.match(body, /<input class="nav-search-input" type="search" name="q" value="needle"/);
});

void test('検索の結果ページは、行の字と検索語を HTML として解釈しない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Markup', ['<b>needle</b> <img src=x onerror=alert(1)>'], s.clock.t);

  const res = await s.request(`/proj/search/page?q=${encodeURIComponent('needle <script>')}`, {}, cookie);

  const body = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(body, /<b>needle<\/b>/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.doesNotMatch(body, /value="needle <script>"/);
  assert.match(body, /value="needle &lt;script&gt;"/);
});

void test('検索語が無いときと長すぎるときは、結果を並べずに理由を示す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['needle'], s.clock.t);

  const empty = await s.request('/proj/search/page', {}, cookie);
  assert.equal(empty.status, 200);
  const emptyBody = await empty.text();
  assert.match(emptyBody, /検索する語を入れてください。/);
  assert.doesNotMatch(emptyBody, /class="search-results"/);

  const tooLong = await s.request(`/proj/search/page?q=${'a'.repeat(1_001)}`, {}, cookie);
  assert.equal(tooLong.status, 400);
  assert.match(await tooLong.text(), /検索する語が長すぎます。/);

  const missing = await s.request('/missing/search/page?q=needle', {}, cookie);
  assert.equal(missing.status, 404);
});

void test('ページの閲覧表示と未作成のページにも、上部のバーに検索欄がある', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['needle'], s.clock.t);

  for (const path of ['/proj/Alpha', '/proj/NotYet']) {
    const body = await (await s.request(path, {}, cookie)).text();
    assert.match(body, /<form class="nav-search" role="search" action="\/proj\/search\/page" method="get"/, path);
    assert.match(body, /<script type="module" src="\/assets\/build\/search\.js"><\/script>/, path);
  }
});
