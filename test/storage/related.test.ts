import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { seedPage } from '../helpers/pages.ts';

const now = 1700000000;

void test('getRelatedPages: 1-hop は前方リンク先と逆リンク元', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Fwd] and [Red Link]'], now);
  await seedPage(storage, project.id, 'Fwd', ['content'], now + 1);
  await seedPage(storage, project.id, 'Back', ['see [Home]'], now + 2);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  const oneHop = rel.links1hop.map((p) => p.title).toSorted();
  assert.deepEqual(oneHop, ['Back', 'Fwd']); // 赤リンク 'Red Link' はページが無いので含まれない
  assert.equal(rel.hasBackLinks, true);
});

void test('getRelatedPages: 2-hop は前方リンク先を共有するページ', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Shared Topic]'], now);
  await seedPage(storage, project.id, 'Sibling', ['also [Shared Topic]'], now + 1);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.deepEqual(rel.links1hop, []); // Shared Topic は赤リンク
  assert.deepEqual(rel.links2hop.map((p) => p.title), ['Sibling']);
  assert.deepEqual(rel.links2hop[0].linksLc, ['shared_topic']);
  assert.equal(rel.hasBackLinks, false);
});

void test('getRelatedPages: 1-hop に入ったページは 2-hop から除外', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['[Fwd] [Topic]'], now);
  await seedPage(storage, project.id, 'Fwd', ['[Topic]'], now + 1); // 1hop であり Topic 共有でもある
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.deepEqual(rel.links1hop.map((p) => p.title), ['Fwd']);
  assert.deepEqual(rel.links2hop, []);
});

void test('アイコン参照だけの逆リンクでも hasBackLinks が立つ（hasBackLinksOrIcons の実体）', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  const homeId = await seedPage(storage, project.id, 'Home', ['content'], now);
  await seedPage(storage, project.id, 'User Page', ['by [Home.icon]'], now + 1);
  const rel = await storage.getRelatedPages(project.id, homeId, 'home');
  assert.equal(rel.hasBackLinks, true);
});

void test('listPageTitles: 原文タイトルのリンクを返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'Page One', ['[Foo Bar] #tag', 'https://i.gyazo.com/x.png'], now);
  const titles = await storage.listPageTitles(project.id);
  assert.equal(titles.length, 1);
  assert.equal(titles[0].title, 'Page One');
  assert.equal(titles[0].hasIcon, true); // image がある
  assert.deepEqual(titles[0].links.toSorted(), ['Foo Bar', 'tag']);
});

void test('listPageTitles: image は pages.image をそのまま返す', async () => {
  const { storage } = makeStorage();
  const project = await storage.ensureProject('proj', now);
  await seedPage(storage, project.id, 'With Image', ['https://i.gyazo.com/x.png'], now);
  const titles = await storage.listPageTitles(project.id);
  assert.equal(titles.find((t) => t.title === 'With Image')!.image, 'https://i.gyazo.com/x.png');
});
