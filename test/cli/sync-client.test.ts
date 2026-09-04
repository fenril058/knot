import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSyncClient, SyncHttpError } from '../../src/cli/sync/client.ts';

type Handler = (url: string, init?: RequestInit) => Response;

function fakeFetch(handler: Handler): typeof fetch {
  // Request をそのまま String() すると '[object Request]' になるので URL を取り出す
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(url instanceof Request ? url.url : String(url), init)));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const opts = { baseUrl: 'http://h', project: 'proj', token: 'knot_t' };
const p = (i: number) => ({ id: `id${i}`, title: `T${i}`, version: 1 });

void test('listPages: ページングして全件返し、認証ヘッダを送る', async () => {
  const calls: string[] = [];
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url, init) => {
      calls.push(url);
      assert.equal(new Headers(init?.headers).get('x-personal-access-token'), 'knot_t');
      const skip = Number(new URL(url).searchParams.get('skip'));
      const pages = [p(skip), p(skip + 1)].filter((x) => Number(x.id.slice(2)) < 3);
      return json(200, { count: 3, pages });
    }),
  });
  const result = await client.listPages();
  assert.deepEqual(result.map((x) => x.id), ['id0', 'id1', 'id2']);
  assert.ok(calls.every((u) => u.includes('sort=title')));
});

void test('listPages: version が無いサーバはエラーにする', async () => {
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() => json(200, { count: 1, pages: [{ id: 'a', title: 'A' }] })),
  });
  await assert.rejects(client.listPages(), SyncHttpError);
});

void test('listPages: id 重複と件数不一致はエラーにする', async () => {
  const dup = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() =>
      json(200, { count: 2, pages: [{ id: 'a', title: 'A', version: 1 }, { id: 'a', title: 'B', version: 1 }] })),
  });
  await assert.rejects(dup.listPages(), SyncHttpError);
  const short = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() => json(200, { count: 5, pages: [{ id: 'a', title: 'A', version: 1 }] })),
  });
  await assert.rejects(short.listPages(), SyncHttpError);
});

void test('getPage: 詳細を text に組み立てる。404 は null', async () => {
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url) =>
      url.includes('Missing')
        ? json(404, { error: 'not_found' })
        : json(200, {
            id: 'p1', title: 'Alpha', version: 4,
            lines: [{ id: 'l1', text: 'Alpha' }, { id: 'l2', text: 'body' }],
          })),
  });
  assert.deepEqual(await client.getPage('Alpha'), { id: 'p1', title: 'Alpha', version: 4, text: 'Alpha\nbody' });
  assert.equal(await client.getPage('Missing'), null);
});

void test('putText: X-Knot-Client を送り、200 は ok、409 は conflict', async () => {
  const bodies: unknown[] = [];
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url, init) => {
      assert.equal(init?.method, 'PUT');
      assert.equal(new Headers(init?.headers).get('x-knot-client'), 'knot-sync');
      // init.body は BodyInit（ReadableStream 等を含む）。テストでは文字列しか渡さないので明示的に絞る
      assert.equal(typeof init?.body, 'string');
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const body = JSON.parse(init?.body as string) as { baseVersion: number };
      bodies.push(body);
      return body.baseVersion === 3 ? json(200, { version: 4, commitId: 'c' }) : json(409, { error: 'conflict' });
    }),
  });
  assert.deepEqual(await client.putText('Alpha', 'p1', 3, 'Alpha\nbody'), { kind: 'ok', version: 4 });
  assert.deepEqual(await client.putText('Alpha', null, 0, 'Alpha\nbody'), { kind: 'conflict' });
  assert.deepEqual(bodies, [
    { pageId: 'p1', baseVersion: 3, text: 'Alpha\nbody' },
    { baseVersion: 0, text: 'Alpha\nbody' },
  ]);
});

void test('401 は認証エラーとして SyncHttpError(status=401)', async () => {
  const client = makeSyncClient({ ...opts, fetchFn: fakeFetch(() => json(401, { error: 'unauthorized' })) });
  await assert.rejects(client.listPages(), (e: SyncHttpError) => e.status === 401);
});
