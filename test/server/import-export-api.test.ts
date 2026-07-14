import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

const exportData = {
  name: 'proj',
  displayName: 'Proj',
  exported: 1700000000,
  users: [{ id: 'a'.repeat(24), name: 'bob', displayName: 'Bob' }],
  pages: [{
    id: '0'.repeat(24), title: 'Imported', created: 1600000000, updated: 1600000001,
    lines: [
      { id: '1'.repeat(24), text: 'Imported', userId: 'a'.repeat(24), created: 1600000000, updated: 1600000000 },
      { id: '2'.repeat(24), text: 'body [Link]', userId: 'a'.repeat(24), created: 1600000000, updated: 1600000000 },
    ],
  }],
};

async function setup() {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  return { s, cookie };
}

test('import → 読み取り API で見える → export で往復', async () => {
  const { s, cookie } = await setup();
  const imp = await s.request('/api/knot/projects/proj/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exportData),
  }, cookie);
  assert.equal(imp.status, 200);
  const summary = await imp.json();
  assert.equal(summary.created, 1);

  const page = await s.request('/api/pages/proj/Imported', {}, cookie);
  assert.equal(page.status, 200);
  assert.equal((await page.json()).lines[1].text, 'body [Link]');

  const exp = await s.request('/api/knot/projects/proj/export', {}, cookie);
  assert.equal(exp.status, 200);
  const out = await exp.json();
  assert.equal(out.name, 'proj');
  assert.equal(out.displayName, 'Proj');
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].lines[1].text, 'body [Link]');
  assert.ok(out.users.some((u: { name: string }) => u.name === 'bob'));
});

test('onConflict=skip が既定、overwrite 指定で上書き', async () => {
  const { s, cookie } = await setup();
  const post = (query: string) => s.request(`/api/knot/projects/proj/import${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exportData),
  }, cookie);
  await post('');
  const skipped = await (await post('')).json();
  assert.equal(skipped.skipped, 1);
  const overwritten = await (await post('?onConflict=overwrite')).json();
  assert.equal(overwritten.overwritten, 1);
  assert.equal((await post('?onConflict=bogus')).status, 400);
});

test('不正な body と format は 400', async () => {
  const { s, cookie } = await setup();
  const bad = await s.request('/api/knot/projects/proj/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages: 'not-an-array' }),
  }, cookie);
  assert.equal(bad.status, 400);
  assert.equal((await s.request('/api/knot/projects/none/export', {}, cookie)).status, 404);
  await s.request('/api/knot/projects/proj/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exportData),
  }, cookie);
  assert.equal((await s.request('/api/knot/projects/proj/export?format=bogus', {}, cookie)).status, 400);
});
