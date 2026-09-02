import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function setup() {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const rename = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  return { s, project, cookie, rename };
}

void test('rename がタイトルを変え、rewritten を返す', async () => {
  const { s, project, rename } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Old Name', ['content'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old Name]'], s.clock.t + 1);
  const res = await rename('Old Name', { pageId, baseVersion: 1, newTitle: 'New Name', rewriteLinks: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, 'New Name');
  assert.deepEqual(body.rewritten, [{ id: srcId, title: 'Src', version: 2 }]);
});

void test('rewriteLinks 省略時は書き換えない', async () => {
  const { s, project, rename } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t);
  const srcId = await seedPage(s.storage, project.id, 'Src', ['[Old]'], s.clock.t + 1);
  const res = await rename('Old', { pageId, baseVersion: 1, newTitle: 'New' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).rewritten, []);
  const src = await s.storage.getPageById(srcId);
  assert.equal(src!.lines[1]!.text, '[Old]');
});

void test('rewriteLinks が boolean でなければ 400', async () => {
  const { s, project, rename } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t);
  const res = await rename('Old', { pageId, baseVersion: 1, newTitle: 'New', rewriteLinks: 'true' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request', message: 'rewriteLinks must be a boolean' });
});

void test('占有タイトルへの rename は 409 reason title、baseVersion 不一致は 409 reason version', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'Taken', ['x'], s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Old', ['x'], s.clock.t + 1);
  const res = await rename('Old', { pageId, baseVersion: 1, newTitle: 'Taken' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.reason, 'title');
  assert.equal(body.page.title, 'Taken');
  const stale = await rename('Old', { pageId, baseVersion: 9, newTitle: 'Fresh' });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, pageId);
  assert.equal(conflict.page.version, 1);
});

void test('rename は pageId と非負整数の baseVersion と newTitle を必須にする', async () => {
  const { s, project, rename } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'P', ['x'], s.clock.t);

  for (const body of [
    {},
    { baseVersion: 1, newTitle: 'X' },
    { pageId, newTitle: 'X' },
    { pageId, baseVersion: 1 },
    { pageId: '', baseVersion: 1, newTitle: 'X' },
    { pageId: 1, baseVersion: 1, newTitle: 'X' },
    { pageId, baseVersion: '1', newTitle: 'X' },
    { pageId, baseVersion: -1, newTitle: 'X' },
    { pageId, baseVersion: 1.5, newTitle: 'X' },
    { pageId, baseVersion: 1, newTitle: 42 },
  ]) {
    assert.equal((await rename('P', body)).status, 400, JSON.stringify(body));
  }

  assert.equal((await rename('P', { pageId, baseVersion: 1, newTitle: '' })).status, 400);
  assert.equal((await rename('P', { pageId, baseVersion: 1, newTitle: 'P' })).status, 400);
  const current = await s.storage.getPageById(pageId);
  assert.equal(current!.title, 'P');
  assert.equal(current!.version, 1);
});

void test('不在の pageId と他プロジェクトの pageId は 404', async () => {
  const { s, project, rename } = await setup();
  await seedPage(s.storage, project.id, 'P', ['x'], s.clock.t);
  const other = await s.storage.ensureProject('other', s.clock.t);
  const otherId = await seedPage(s.storage, other.id, 'Elsewhere', ['x'], s.clock.t + 1);

  assert.equal((await rename('P', { pageId: 'missing', baseVersion: 1, newTitle: 'X' })).status, 404);
  assert.equal((await rename('P', { pageId: otherId, baseVersion: 1, newTitle: 'X' })).status, 404);
  const untouched = await s.storage.getPageById(otherId);
  assert.equal(untouched!.title, 'Elsewhere');
  assert.equal(untouched!.version, 1);
});

void test('旧タイトルの再利用後も pageId で元ページを追跡し、別ページを rename しない', async () => {
  const { s, project, rename } = await setup();
  const originalId = await seedPage(s.storage, project.id, 'Old', ['original'], s.clock.t);
  const sourceId = await seedPage(s.storage, project.id, 'Src', ['[Old]'], s.clock.t + 1);
  const renamed = await s.storage.renamePage({
    projectId: project.id,
    pageId: originalId,
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: false,
    actorId: 'u',
    now: s.clock.t + 2,
  });
  assert.equal(renamed.kind, 'applied');
  const replacementId = await seedPage(s.storage, project.id, 'Old', ['replacement'], s.clock.t + 3);

  const stale = await rename('Old', { pageId: originalId, baseVersion: 1, newTitle: 'Renamed', rewriteLinks: true });

  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, originalId);
  assert.equal(conflict.page.title, 'New');
  assert.equal(conflict.page.version, 2);
  const original = await s.storage.getPageById(originalId);
  assert.equal(original!.title, 'New');
  assert.equal(original!.version, 2);
  const replacement = await s.storage.getPageById(replacementId);
  assert.equal(replacement!.title, 'Old');
  assert.equal(replacement!.version, 1);
  const source = await s.storage.getPageById(sourceId);
  assert.equal(source!.lines[1]!.text, '[Old]');
  assert.equal(source!.version, 1);
});

void test('他クライアントが先に削除した場合も最新 snapshot 付きの 409 になる', async () => {
  const { s, project, rename } = await setup();
  const pageId = await seedPage(s.storage, project.id, 'Doomed', ['x'], s.clock.t);
  const deleted = await s.storage.deletePage({
    projectId: project.id,
    pageId,
    baseVersion: 1,
    actorId: 'u',
    now: s.clock.t + 1,
  });
  assert.equal(deleted.kind, 'applied');

  const stale = await rename('Doomed', { pageId, baseVersion: 1, newTitle: 'Renamed' });

  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.reason, 'version');
  assert.equal(conflict.page.id, pageId);
  assert.equal(conflict.page.version, 2);
});
