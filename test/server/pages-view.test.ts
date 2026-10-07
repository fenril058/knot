import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('GET /:project/:title: レンダリング結果・空リンク・テロメア・関連ページを含む', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const alphaId = await seedPage(s.storage, project.id, 'Alpha', ['see [Beta] and [Ghost]'], s.clock.t + 1);
  const res = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="empty-link"[^>]*>Ghost</);
  assert.match(body, /href="\/proj\/Beta"[^>]*>Beta</);
  assert.match(body, /class="telomere/);
  assert.match(body, /Beta/);
  assert.doesNotMatch(body, /id="edit-page-button"/);
  assert.match(body, /<div class="page-nav-start"><a href="\/proj">proj<\/a><\/div>/);
  assert.match(body, /data-known-pages="[^"]*Beta[^"]*"/);
  void alphaId;
});

void test('テロメアは押せるボタンで、行のテロメアの tab stop は先頭の行の 1 つだけにする', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['one', 'two'], s.clock.t);
  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();
  const telomeres = Array.from(body.matchAll(/<button type="button" class="telomere[^"]*" tabindex="(-?\d+)"[^>]*><\/button>/g));
  assert.deepEqual(telomeres.map((match) => match[1]), ['0', '-1', '-1']);
  // 行の Actor の ID は人が読める名前ではないので、閲覧表示には出さない。
  assert.doesNotMatch(body, /data-user=/);
});

void test('深いインデントを深さ分のDOM要素へ展開しない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Deep', [`${' '.repeat(1000)}nested`], s.clock.t);

  const body = await (await s.request('/proj/Deep', {}, cookie)).text();

  assert.equal(body.match(/class="line-indent"/g)?.length ?? 0, 0);
  assert.match(body, /class="line-indent-prefix"/);
});

void test('1-hop と 2-hop の関連ページを一覧と同じカードで表示する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[/files/01ABC/beta.png]', '[Beta Link] の説明'], s.clock.t);
  await seedPage(
    s.storage,
    project.id,
    'Gamma',
    ['[/files/01ABC/gamma.png]', '[Ghost]', 'Gamma の説明'],
    s.clock.t + 1,
  );
  await seedPage(s.storage, project.id, 'Delta', ['Delta の説明'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta] と [Ghost] と [Delta]'], s.clock.t + 3);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  // 見出しは画面に出さず、1-hop の行は「Links」の札で始まる（#249）。
  assert.match(body, /<section class="related-pages" aria-labelledby="related-pages-title"><h2 id="related-pages-title" class="visually-hidden">関連ページ<\/h2>/);
  assert.match(body, /<ul class="card-grid related-group" role="list" aria-label="Links"><li class="relation-label links"><span class="relation-label-card"><span class="relation-label-title">Links<\/span>/);
  assert.match(body, /<li><a class="card" href="\/proj\/Beta">/);
  assert.match(body, /href="\/proj\/Beta">[\s\S]*?<h3>Beta<\/h3>/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/beta\.png" alt="" width="320" height="100" loading="eager">/,
  );
  // Cosense と同じく、画像のあるページの札は画像だけを置き、無いページの札は説明文を置く。
  assert.doesNotMatch(body, /Beta Link の説明/);
  assert.match(body, /href="\/proj\/Delta">[\s\S]*?<h3>Delta<\/h3>\s*<p>Delta の説明<\/p>/);
  // 2-hop の行は共有するリンク先（ページの無い Ghost）の名前の札で始まる。
  assert.match(body, /<ul class="card-grid related-group" role="list" aria-label="Ghost"><li class="relation-label headword"><a class="relation-label-card" href="\/proj\/Ghost"><span class="relation-label-title">Ghost<\/span>/);
  assert.match(body, /<li><a class="card" href="\/proj\/Gamma">/);
  assert.doesNotMatch(body, /逆リンクまたはアイコン参照あり/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/gamma\.png" alt="" width="320" height="100" loading="lazy">/,
  );
  assert.doesNotMatch(body, /Gamma の説明/);
});

void test('2-hop の札は共有するリンク先ごとの行に分け、行はページの中でリンクが現れた順に並べる（#249）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Zeta Page', ['zeta'], s.clock.t);
  await seedPage(s.storage, project.id, 'Viaz', ['[zeta_page]'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Both', ['[Zeta Page] [Eta]'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Viae', ['[Eta]'], s.clock.t + 3);
  await seedPage(s.storage, project.id, 'Alpha', ['[Zeta Page] の後に [Eta]'], s.clock.t + 4);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  const labels = [...body.matchAll(/<ul class="card-grid related-group" role="list" aria-label="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Links', 'Zeta Page', 'Eta']);
  const group = (label: string): string => {
    const start = body.indexOf(`aria-label="${label}">`);
    return body.slice(start, body.indexOf('</ul>', start));
  };
  // 見出しはリンク先のページのタイトル（書かれたリンクの綴りではない）で、そのページへのリンク。
  assert.match(group('Zeta Page'), /<a class="relation-label-card" href="\/proj\/Zeta_Page">/);
  assert.deepEqual([...group('Zeta Page').matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]), ['Both', 'Viaz']);
  assert.deepEqual([...group('Eta').matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]), ['Viae', 'Both']);
});

void test('関連ページの札の説明文のアイコンは、画像の分かるページなら字の高さの画像で描く（#256）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Gamma', ['[https://i.gyazo.com/gamma.png]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[Gamma.icon] の説明'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta]'], s.clock.t + 2);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.match(body, /href="\/proj\/Beta">[\s\S]*?<p><span class="card-link"><img class="inline-icon" src="https:\/\/i\.gyazo\.com\/gamma\.png" alt=""><\/span> の説明<\/p>/);
});

void test('関連ページの外部画像は allowedImageHosts で許可したホストだけ表示する', async () => {
  const s = await makeServer({ allowedImageHosts: ['allowed.example'] });
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Allowed', ['https://allowed.example/a.png'], s.clock.t);
  await seedPage(s.storage, project.id, 'Blocked', ['https://blocked.example/b.png'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Allowed] [Blocked]'], s.clock.t + 2);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.match(body, /<img class="card-image" src="https:\/\/allowed\.example\/a\.png"/);
  assert.doesNotMatch(body, /<img class="card-image" src="https:\/\/blocked\.example\/b\.png"/);
});

void test('閲覧画面に操作メニューと複製・リネーム・削除 dialog がありインラインハンドラを使わない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['body'], s.clock.t);

  const res = await s.request('/proj/Alpha', {}, cookie);
  const body = await res.text();

  assert.match(
    body,
    /id="page-menu-root"[^>]*data-project="proj"[^>]*data-title="Alpha"[^>]*data-page-id="[^"]+"[^>]*data-version="1"/,
  );
  // ページ情報とページの操作は、印だけのボタン（#251）。名前は aria-label で伝える。
  assert.match(body, /<details id="page-info" class="page-actions">\n<summary aria-label="ページ情報"><svg /);
  assert.match(body, /<details id="page-actions" class="page-actions">\n<summary aria-label="ページの操作"><svg /);
  assert.match(body, /<a class="page-menu-link" href="\/proj\/random\/page" aria-label="ランダムなページへ移る"><svg /);
  // 作成と更新の日時は、閲覧者の時間帯で page-menu.js が書き直す。サーバは UTC で置く。
  const created = new Date((s.clock.t) * 1000).toISOString();
  assert.match(body, new RegExp(`<p class="page-info-row">作成 <time datetime="${created}">${created.slice(0, 16).replace('T', ' ')} UTC</time></p>`));
  assert.match(body, /<p class="page-info-row">更新 <time datetime="[^"]+">[^<]+ UTC<\/time><\/p>/);
  assert.match(body, /<dialog[^>]*id="duplicate-dialog"/);
  assert.match(body, /<dialog[^>]*id="rename-dialog"/);
  assert.match(body, /<dialog[^>]*id="delete-dialog"/);
  assert.match(body, /<script type="module" src="\/assets\/build\/page-menu\.js"><\/script>/);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
});

void test('初回訪問は全行 unread、再訪問（編集なし）は unread が消える', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  const first = await s.request('/proj/Alpha', {}, cookie);
  assert.match(await first.text(), /telomere unread/);
  const second = await s.request('/proj/Alpha', {}, cookie);
  assert.doesNotMatch(await second.text(), /telomere unread/);
});

void test('ページ表示の knownPages は listKnownPages を使い listPageTitles を呼ばない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta]'], s.clock.t);
  s.storage.listPageTitles = async () => {
    throw new Error('listPageTitles must not be called by the HTML page route');
  };

  const res = await s.request('/proj/Alpha', {}, cookie);

  assert.equal(res.status, 200);
  assert.match(await res.text(), /href="\/proj\/Beta"/);
});

void test('存在しないページは 404 と新規作成の案内', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const res = await s.request('/proj/Nope', {}, cookie);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Nope/);
  assert.match(body, /id="edit-page-button"[^>]*>このタイトルで新規作成する<\/button>/);
  assert.match(body, /data-known-pages="[^"]*Beta[^"]*"/);
});

void test('GET /:project/:title: 存在しないプロジェクトは layout を使った HTML 404', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const res = await s.request('/missing/Nope', {}, cookie);

  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/);
  assert.match(body, /プロジェクトが見つかりません/);
  assert.match(body, /missing/);
});

for (const [name, headers] of [
  ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
  ['prefetch', { 'Sec-Purpose': 'prefetch' }],
] as const) {
  void test(`${name} の GET は再訪問しても unread を既読にしない`, async () => {
    const s = await makeServer();
    const cookie = await loginAs(s);
    const project = await s.storage.ensureProject('proj', s.clock.t);
    await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

    const first = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await first.text(), /telomere unread/);
    const second = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await second.text(), /telomere unread/);
  });
}

void test('GET /:project/random/page は同じプロジェクトの無作為なページへ移る（#258）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('empty', s.clock.t);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  for (const title of ['Alpha', 'Beta Page', 'Gamma']) await seedPage(s.storage, project.id, title, ['body'], s.clock.t);

  const seen = new Set<string>();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = await s.request('/proj/random/page', { redirect: 'manual' }, cookie);
    assert.equal(res.status, 302);
    seen.add(res.headers.get('location') ?? '');
  }
  // 40 回のうちに 3 つのページのどれにも移り、ほかへは移らない。
  assert.deepEqual([...seen].toSorted(), ['/proj/Alpha', '/proj/Beta_Page', '/proj/Gamma']);

  const none = await s.request('/empty/random/page', { redirect: 'manual' }, cookie);
  assert.equal(none.status, 302);
  assert.equal(none.headers.get('location'), '/empty');
  assert.equal((await s.request('/missing/random/page', { redirect: 'manual' }, cookie)).status, 404);
});
