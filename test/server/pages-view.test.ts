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

void test('ページが無くても、ほかのページからリンクされているリンク先は空リンクの色にしない（#285）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[Via Beta]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Other', ['[Hub Topic] #shared'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta] [Hub Topic] #shared [Via Beta] [Lonely]'], s.clock.t + 2);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  // 2-hop の札（Other）や 1-hop の札（Beta）がリンクしているリンク先は、ページのあるリンクと同じ見た目。
  assert.match(body, /<a href="\/proj\/Hub_Topic" class="page-link">Hub Topic<\/a>/);
  assert.match(body, /<a href="\/proj\/shared" class="page-link">#shared<\/a>/);
  assert.match(body, /<a href="\/proj\/Via_Beta" class="page-link">Via Beta<\/a>/);
  // このページからしかリンクされていないリンク先だけを空リンクにする。
  assert.match(body, /<a href="\/proj\/Lonely" class="empty-link">Lonely<\/a>/);
  // 編集表示も同じ色で描くよう、リンク先を編集表示へ渡す。
  assert.match(body, /data-known-pages="[^"]*&quot;title&quot;:&quot;Hub Topic&quot;,&quot;image&quot;:null[^"]*"/);
  assert.doesNotMatch(body, /data-known-pages="[^"]*Lonely[^"]*"/);
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
  assert.match(body, /<li[^>]*><a class="card" href="\/proj\/Beta">/);
  assert.match(body, /href="\/proj\/Beta">[\s\S]*?<h3>Beta<\/h3>/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/beta\.png" alt="" width="320" height="100" loading="eager">/,
  );
  // Cosense と同じく、画像のあるページの札は画像だけを置き、無いページの札は説明文を置く。
  // 札の li の data-search には、絞り込みのために説明文も入る（#281）ので、札の中だけを見る。
  const card = (title: string): string => {
    const start = body.indexOf(`<a class="card" href="/proj/${title}">`);
    return body.slice(start, body.indexOf('</a>', start));
  };
  assert.doesNotMatch(card('Beta'), /Beta Link の説明/);
  assert.match(body, /href="\/proj\/Delta">[\s\S]*?<h3>Delta<\/h3>\s*<p>Delta の説明<\/p>/);
  // 2-hop の行は共有するリンク先（ページの無い Ghost）の名前の札で始まる。
  assert.match(body, /<ul class="card-grid related-group" role="list" aria-label="Ghost"><li class="relation-label headword"><a class="relation-label-card" href="\/proj\/Ghost"><span class="relation-label-title">Ghost<\/span>/);
  assert.match(body, /<li[^>]*><a class="card" href="\/proj\/Gamma">/);
  assert.doesNotMatch(body, /逆リンクまたはアイコン参照あり/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/gamma\.png" alt="" width="320" height="100" loading="lazy">/,
  );
  assert.doesNotMatch(card('Gamma'), /Gamma の説明/);
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
  assert.deepEqual(cardTitles(group('Zeta Page')), ['Both', 'Viaz']);
  // Both は Eta も共有するが、本文で先に現れる Zeta Page の行にだけ置く（#278）。
  assert.deepEqual(cardTitles(group('Eta')), ['Viae']);
});

function cardTitles(html: string): (string | undefined)[] {
  return [...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((match) => match[1]);
}

function relatedGroups(body: string): Map<string, (string | undefined)[]> {
  const groups = new Map<string, (string | undefined)[]>();
  for (const match of body.matchAll(/<ul class="card-grid related-group" role="list" aria-label="([^"]+)">([\s\S]*?)<\/ul>/g)) {
    groups.set(match[1] ?? '', cardTitles(match[2] ?? ''));
  }
  return groups;
}

void test('2-hop の札は、本文で最初に共有するリンク先の行にだけ置き、行の中は共有するリンク先の多い順に並べる（#278）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Zeta Page', ['zeta'], s.clock.t);
  await seedPage(s.storage, project.id, 'Both', ['[Zeta Page] [Eta] [Theta]'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Viae', ['[Eta]'], s.clock.t + 3);
  await seedPage(s.storage, project.id, 'Viae Newer', ['[Eta]'], s.clock.t + 4);
  await seedPage(s.storage, project.id, 'Viaz', ['[Zeta Page]'], s.clock.t + 5);
  await seedPage(s.storage, project.id, 'Alpha', ['[Zeta Page] の後に [Eta] と [Theta]'], s.clock.t + 6);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  // Theta を共有する札（Both）は Zeta Page の行に入ったので、Theta の行は出さない。
  assert.deepEqual([...relatedGroups(body)], [
    ['Links', ['Zeta Page']],
    // Both は 3 つ、Viaz は 1 つのリンク先を共有する。
    ['Zeta Page', ['Both', 'Viaz']],
    // 共有する数が同じ札は、更新日時の新しい順。
    ['Eta', ['Viae Newer', 'Viae']],
  ]);
});

void test('Links の行は、前方リンクの札を先に、関連度の大きい順、同じなら更新日時の新しい順に並べる（#278）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['[Plain] [Mutual] [Sharing] と [Hub]'], s.clock.t);
  // 前方リンク: Mutual はこのページにリンクし、Sharing はこのページと Hub を共有する（どちらも関連度 1）。
  await seedPage(s.storage, project.id, 'Mutual', ['[Alpha]'], s.clock.t + 6);
  await seedPage(s.storage, project.id, 'Sharing', ['[Hub]'], s.clock.t + 7);
  await seedPage(s.storage, project.id, 'Plain', ['plain'], s.clock.t + 9);
  // 逆リンク: Back Sharing はこのページにリンクし、Hub も共有する（関連度 2）。
  await seedPage(s.storage, project.id, 'Back Sharing', ['[Alpha] [Hub]'], s.clock.t + 8);
  await seedPage(s.storage, project.id, 'Back', ['[Alpha]'], s.clock.t + 10);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.deepEqual([...relatedGroups(body)], [
    ['Links', ['Sharing', 'Mutual', 'Plain', 'Back Sharing', 'Back']],
  ]);
});

void test('関連ページの最後に、ページが無く、ほかのページからもリンクされていないリンク先を「New Links」の行に並べる（#283）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[Via Beta]'], s.clock.t);
  await seedPage(s.storage, project.id, 'Other', ['[Shared Ghost]'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta] [Lonely One] [Shared Ghost] [Via Beta] [Lonely Two]'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Solo', ['[Nowhere]'], s.clock.t + 3);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  // Shared Ghost は 2-hop の札（Other）が、Via Beta は 1-hop の札（Beta）がリンクしているので入らない。
  assert.deepEqual([...relatedGroups(body)], [
    ['Links', ['Beta']],
    ['Shared Ghost', ['Other']],
    ['New Links', ['Lonely One', 'Lonely Two']],
  ]);
  assert.match(body, /<li class="relation-label empty-links"><span class="relation-label-card"><span class="relation-label-title">New Links<\/span>/);
  // 札はそのページへのリンクで、絞り込みはタイトルで探す。説明文の代わりに線を描く。
  assert.match(body, /<li class="new-link" data-title="Lonely One" data-search="Lonely One"><a class="card" href="\/proj\/Lonely_One">\s*<h3>Lonely One<\/h3>\s*<span class="card-placeholder" aria-hidden="true">/);

  // 関連ページが無くても、New Links の行と toolbar は置く。
  const solo = await (await s.request('/proj/Solo', {}, cookie)).text();
  assert.deepEqual([...relatedGroups(solo)], [['New Links', ['Nowhere']]]);
  assert.match(solo, /class="related-toolbar"/);
});

void test('関連ページの行の上に絞り込み欄と並び替えを置き、札に並び替えと絞り込みに使う値を付ける（#281）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[Gamma] の説明'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta]'], s.clock.t + 2);
  await seedPage(s.storage, project.id, 'Lonely', ['no links'], s.clock.t + 3);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.match(body, /<input class="related-filter-input" type="search" autocomplete="off" spellcheck="false" aria-label="関連ページを絞り込む">/);
  const tabs = [...body.matchAll(/class="tool-button related-sort-tab" data-sort="(\w+)" aria-pressed="(\w+)">([^<]+)</g)];
  assert.deepEqual(tabs.map((match) => [match[1], match[2], match[3]]), [['related', 'true', '関連度'], ['updated', 'false', '更新日時']]);
  // menu には、タブにある並び替えも含めてすべて置く（タブにある分は広い画面で CSS が隠す）。ページランクは置かない。
  const optionsStart = body.indexOf('<div class="related-sort-options">');
  const options = body.slice(optionsStart, body.indexOf('</details>', optionsStart));
  assert.deepEqual([...options.matchAll(/<button type="button" data-sort="(\w+)"/g)].map((match) => match[1]),
    ['related', 'updated', 'created', 'accessed', 'linked', 'title']);
  assert.doesNotMatch(body, /ページランク/);
  // 札の値: 作成・更新日時、最終アクセス、被リンク数と、絞り込みで探す字（タイトル・説明文・リンク先）。
  assert.match(body, new RegExp(
    `<li data-title="Beta" data-created="${s.clock.t + 1}" data-updated="${s.clock.t + 1}" data-accessed="0" data-linked="1" data-search="Beta\\n\\[Gamma\\] の説明\\ngamma"><a class="card"`,
  ));

  // 関連ページの無いページには置かない。
  const lonely = await (await s.request('/proj/Lonely', {}, cookie)).text();
  assert.doesNotMatch(lonely, /related-toolbar/);
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

void test('存在しないページは 404 で、Cosense と同じくタイトルの行だけの空のページと、そこへリンクしているページを描く（#289）', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  await seedPage(s.storage, project.id, 'Linker', ['[Nope Topic] へのリンク'], s.clock.t + 1);
  // URL のタイトルの _ は空白にする（Cosense と同じ）。
  const res = await s.request('/proj/Nope_Topic', {}, cookie);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /<title>Nope Topic<\/title>/);
  // 紙面はタイトルの行だけ。テロメアは未読の太さで、押せない。作成ボタンは置かない。
  assert.match(body, /<div class="page not-persistent">\s*<div\s+id="editor-root"[^>]*>\s*<div class="line-row" id="Lnew-title">\s*<span class="telomere unread w-10" aria-hidden="true"><\/span>\s*<h1 class="line-title">Nope Topic<\/h1>\s*<\/div>\s*<\/div>/);
  assert.doesNotMatch(body, /edit-page-button|まだありません|まだ作成されていません/);
  assert.match(body, /data-title="Nope Topic"/);
  assert.match(body, /data-known-pages="[^"]*Beta[^"]*"/);
  // このタイトルへリンクしているページを、関連ページの Links の行に描く。
  assert.deepEqual([...relatedGroups(body)], [['Links', ['Linker']]]);
  assert.match(body, /class="related-toolbar"/);
  assert.match(body, /<script type="module" src="\/assets\/build\/related-pages\.js"><\/script>/);
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
