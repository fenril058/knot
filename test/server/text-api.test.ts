import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function setup() {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const put = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  const getText = (title: string) => s.request(`/api/pages/proj/${encodeURIComponent(title)}/text`, {}, cookie);
  return { s, project, put, getText };
}

void test('新規作成 → 全文置換 → GET text で往復', async () => {
  const { s, project, put, getText } = await setup();
  const create = await put('Doc', { baseVersion: 0, text: 'Doc\nline one\nline two' });
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.version, 1);
  assert.match(created.commitId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

  const page = await s.storage.getPageByTitle(project.id, 'doc');
  const update = await put('Doc', {
    pageId: page!.id,
    baseVersion: 1,
    text: 'Doc\nline one changed\nline two\nline three',
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).version, 2);
  assert.equal(await (await getText('Doc')).text(), 'Doc\nline one changed\nline two\nline three');
});

void test('変更のない PUT はコミットを作らない', async () => {
  const { s, project, put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nsame' });
  const page = await s.storage.getPageByTitle(project.id, 'doc');
  const noop = await put('Doc', { pageId: page!.id, baseVersion: 1, text: 'Doc\nsame' });
  assert.equal(noop.status, 200);
  assert.deepEqual(await noop.json(), { version: 1, commitId: null });
});

void test('baseVersion 不一致は 409 で最新状態を返す', async () => {
  const { s, project, put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nv1' });
  const page = await s.storage.getPageByTitle(project.id, 'doc');
  await put('Doc', { pageId: page!.id, baseVersion: 1, text: 'Doc\nv2' });
  const stale = await put('Doc', { pageId: page!.id, baseVersion: 1, text: 'Doc\nv3' });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.reason, 'version');
  assert.equal(body.page.lines.map((l: { text: string }) => l.text).join('\n'), 'Doc\nv2');
});

void test('編集で残った行の ID とメタデータは保持される', async () => {
  const { s, project, put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nkeep me\ndrop me' });
  const before = await s.storage.getPageByTitle(project.id, 'doc');
  const keepId = before!.lines[1]!.id;
  await put('Doc', { pageId: before!.id, baseVersion: 1, text: 'Doc\nkeep me\nnew line' });
  const after = await s.storage.getPageByTitle(project.id, 'doc');
  assert.equal(after!.lines[1]!.id, keepId); // 不変の行は ID が変わらない
});

void test('既存更新は URL のタイトルではなく pageId で対象を識別する', async () => {
  const { s, project, put } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Doc', ['before'], s.clock.t);

  const response = await put('stale-url', { pageId, baseVersion: 1, text: 'Doc\nafter' });

  assert.equal(response.status, 200);
  const page = await s.storage.getPageById(pageId);
  assert.equal(page!.version, 2);
  assert.deepEqual(page!.lines.map((line) => line.text), ['Doc', 'after']);
});

void test('旧タイトルの再利用後も pageId で元ページを追跡し、別ページを全文置換しない', async () => {
  const { s, project, put } = await setup();
  const originalId = await seedPage(s.storage, project.id, 'Old', ['original'], s.clock.t);
  const renamed = await s.storage.renamePage({
    projectId: project.id,
    pageId: originalId,
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: false,
    actorId: 'u',
    now: s.clock.t + 1,
  });
  assert.equal(renamed.kind, 'applied');
  const replacementId = await seedPage(s.storage, project.id, 'Old', ['replacement'], s.clock.t + 2);

  const stale = await put('Old', {
    pageId: originalId,
    baseVersion: 1,
    text: 'Old\nstale client overwrote this',
  });

  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, originalId);
  assert.equal(conflict.page.title, 'New');
  assert.equal(conflict.page.version, 2);
  const original = await s.storage.getPageById(originalId);
  assert.equal(original!.title, 'New');
  assert.equal(original!.version, 2);
  assert.deepEqual(original!.lines.map((line) => line.text), ['New', 'original']);
  const replacement = await s.storage.getPageById(replacementId);
  assert.equal(replacement!.title, 'Old');
  assert.equal(replacement!.version, 1);
  assert.deepEqual(replacement!.lines.map((line) => line.text), ['Old', 'replacement']);
});

void test('形式不正は 400', async () => {
  const { put } = await setup();
  const emptyCreate = await put('Doc', { baseVersion: 0, text: '' });
  assert.equal(emptyCreate.status, 400);
  assert.equal((await emptyCreate.json()).message, 'baseVersion and non-empty text required');
  assert.equal((await put('Doc', { baseVersion: 0 })).status, 400);
  assert.equal((await put('Doc', { baseVersion: -1, text: 'Doc' })).status, 400);
  assert.equal((await put('Doc', { pageId: '', baseVersion: 1, text: 'Doc' })).status, 400);
  assert.equal((await put('Doc', { pageId: 1, baseVersion: 1, text: 'Doc' })).status, 400);
  // 新規作成で先頭行が URL タイトルと不一致
  assert.equal((await put('Doc', { baseVersion: 0, text: 'Other\nbody' })).status, 400);
  // 既存更新は pageId 必須
  const missingPageId = await put('Ghost', { baseVersion: 2, text: 'Ghost' });
  assert.equal(missingPageId.status, 400);
  assert.equal((await missingPageId.json()).message, 'pageId required for existing page');
});

void test('不在と別プロジェクトの pageId は 404', async () => {
  const { s, put } = await setup();
  const other = await s.storage.ensureProject('other', s.clock.t);
  const otherId = await seedPage(s.storage, other.id, 'Elsewhere', ['keep me'], s.clock.t);

  assert.equal((await put('Ghost', { pageId: 'missing', baseVersion: 2, text: 'Ghost' })).status, 404);
  assert.equal((await put('Elsewhere', { pageId: otherId, baseVersion: 1, text: 'Elsewhere\noverwrite' })).status, 404);
  const untouched = await s.storage.getPageById(otherId);
  assert.equal(untouched!.version, 1);
  assert.deepEqual(untouched!.lines.map((line) => line.text), ['Elsewhere', 'keep me']);
});

void test('削除と競合した全文置換は version を先に照合し、最新 version なら 404', async () => {
  const { s, project, put } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['keep me'], s.clock.t);
  const deleted = await s.storage.deletePage({
    projectId: project.id,
    pageId,
    baseVersion: 1,
    actorId: 'u',
    now: s.clock.t + 1,
  });
  assert.equal(deleted.kind, 'applied');

  const stale = await put('Doomed', { pageId, baseVersion: 1, text: 'Doomed\noverwrite' });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, pageId);
  assert.equal(conflict.page.version, 2);
  assert.equal((await put('Doomed', { pageId, baseVersion: 2, text: 'Doomed\noverwrite' })).status, 404);
  const current = await s.storage.getPageById(pageId);
  assert.equal(current!.deleted, true);
  assert.equal(current!.version, 2);
  assert.deepEqual(current!.lines, []);
});
