import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { ulid } from '../../src/core/id.ts';

async function seedProject(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const mk = async (title: string, body: string[]): Promise<void> => {
    let after = '_head';
    const ops = [title, ...body].map((text) => {
      const id = ulid(s.clock.t * 1000);
      const op = { type: 'insert' as const, id, after, text };
      after = id;
      return op;
    });
    await s.storage.commit({
      projectId: project.id, pageId: ulid(s.clock.t * 1000), commitId: ulid(s.clock.t * 1000),
      baseVersion: 0, ops, userId: 'u', now: s.clock.t,
    });
    s.clock.t += 1;
  };
  await mk('Alpha', ['first line', 'https://i.gyazo.com/abc.png']);
  await mk('Beta', ['see [Alpha]']);
  return project.id;
}

void test('GET /api/pages/:project が Cosense 形状で返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const projectId = await seedProject(s);
  const alphaId = (await s.storage.getPageByTitle(projectId, 'alpha'))!.id;
  const accessed = s.clock.t + 100;
  await s.storage.recordVisit('u1', alphaId, accessed - 10, 1);
  await s.storage.recordVisit('u1', alphaId, accessed, 1);
  await s.storage.recordVisit('u2', alphaId, accessed - 5, 1);
  const res = await s.request('/api/pages/proj', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projectName, 'proj');
  assert.equal(body.skip, 0);
  assert.equal(body.limit, 100);
  assert.equal(body.count, 2);
  assert.deepEqual(body.pages.map((p: { title: string }) => p.title), ['Beta', 'Alpha']); // updated 降順
  const alpha = body.pages[1];
  assert.equal(alpha.image, 'https://i.gyazo.com/abc.png');
  assert.deepEqual(alpha.descriptions, ['first line', 'https://i.gyazo.com/abc.png']);
  assert.equal(alpha.views, 3);
  assert.equal(alpha.linked, 1);
  assert.equal(alpha.accessed, accessed);
  const beta = body.pages[0];
  assert.equal(beta.views, 0);
  assert.equal(beta.accessed, 0);
  // knot 拡張: 同期 CLI が差分検出に使う version
  assert.equal(typeof alpha.version, 'number');
  assert.ok(alpha.version >= 1);
});

void test('skip / limit / sort パラメータ', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const projectId = await seedProject(s);
  const alphaId = (await s.storage.getPageByTitle(projectId, 'alpha'))!.id;
  const betaId = (await s.storage.getPageByTitle(projectId, 'beta'))!.id;
  await s.storage.recordVisit('u1', alphaId, s.clock.t + 10, 1);
  await s.storage.recordVisit('u1', alphaId, s.clock.t + 20, 1);
  await s.storage.recordVisit('u1', betaId, s.clock.t + 30, 1);
  const res = await s.request('/api/pages/proj?skip=1&limit=1&sort=title', {}, cookie);
  const body = await res.json();
  assert.equal(body.skip, 1);
  assert.equal(body.limit, 1);
  assert.deepEqual(body.pages.map((p: { title: string }) => p.title), ['Beta']);
  const byViews = await (await s.request('/api/pages/proj?sort=views', {}, cookie)).json();
  assert.deepEqual(byViews.pages.map((p: { title: string }) => p.title), ['Alpha', 'Beta']);
  const byAccessed = await (await s.request('/api/pages/proj?sort=accessed', {}, cookie)).json();
  assert.deepEqual(byAccessed.pages.map((p: { title: string }) => p.title), ['Beta', 'Alpha']);
  // 不正値は 400
  assert.equal((await s.request('/api/pages/proj?skip=abc', {}, cookie)).status, 400);
  assert.equal((await s.request('/api/pages/proj?sort=bogus', {}, cookie)).status, 400);
});

void test('text と icon', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await seedProject(s);
  const text = await s.request('/api/pages/proj/Alpha/text', {}, cookie);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-type')!, /^text\/plain/);
  assert.equal(await text.text(), 'Alpha\nfirst line\nhttps://i.gyazo.com/abc.png');
  const icon = await s.request('/api/pages/proj/Alpha/icon', { redirect: 'manual' }, cookie);
  assert.equal(icon.status, 302);
  assert.equal(icon.headers.get('location'), 'https://i.gyazo.com/abc.png');
  assert.equal((await s.request('/api/pages/proj/Beta/icon', { redirect: 'manual' }, cookie)).status, 404);
  assert.equal((await s.request('/api/pages/proj/None/text', {}, cookie)).status, 404);
});

void test('タイトルの percent-encoding が解決される', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const id = ulid(s.clock.t * 1000);
  await s.storage.commit({
    projectId: project.id, pageId: ulid(s.clock.t * 1000), commitId: ulid(s.clock.t * 1000), baseVersion: 0,
    ops: [{ type: 'insert', id, after: '_head', text: 'A/B?C' }], userId: 'u', now: s.clock.t,
  });
  const res = await s.request(`/api/pages/proj/${encodeURIComponent('A/B?C')}/text`, {}, cookie);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'A/B?C');
  // 不正な percent-encoding は 500 にせず 404
  assert.equal((await s.request('/api/pages/proj/%E0%A4%A/text', {}, cookie)).status, 404);
});

void test('GET /api/pages/:project/ （末尾スラッシュ）も同じ一覧を返す', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await seedProject(s);
  const [plain, slashed] = await Promise.all([
    s.request('/api/pages/proj', {}, cookie),
    s.request('/api/pages/proj/', {}, cookie),
  ]);
  assert.equal(slashed.status, 200);
  assert.deepEqual(await slashed.json(), await plain.json());
});
