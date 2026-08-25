import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { generateApiToken } from '../../src/server/apiToken.ts';
import type { Storage } from '../../src/storage/types.ts';
import { makeServer } from '../helpers/server.ts';

async function seedPageAs(
  storage: Storage,
  projectId: string,
  title: string,
  actorId: string,
  at: number,
): Promise<void> {
  const titleLineId = ulid(at * 1000);
  await storage.commit({
    projectId,
    pageId: ulid(at * 1000),
    commitId: ulid(at * 1000),
    baseVersion: 0,
    ops: [{ type: 'insert', id: titleLineId, after: '_head', text: title }],
    actorId,
    now: at,
  });
}

void test('GET /api/projects/:project/users はプロジェクトの作者 Actor を返す', async () => {
  const s = await makeServer();
  const loginAccount = await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const importedActorId = await s.storage.upsertActor(
    { id: 'imported-user', name: 'bob', displayName: 'Bob Example' },
    s.clock.t,
  );
  await seedPageAs(s.storage, project.id, 'By Alice', loginAccount.actorId, s.clock.t);
  await seedPageAs(s.storage, project.id, 'By Bob', importedActorId, s.clock.t + 1);

  const res = await s.request('/api/projects/proj/users', {}, cookie);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    projectName: 'proj',
    users: [
      { id: loginAccount.actorId, name: 'alice', displayName: 'alice' },
      { id: importedActorId, name: 'bob', displayName: 'Bob Example' },
    ],
  });
});

void test('GET /api/projects/:project/users は未知プロジェクトに 404 を返す', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');

  const res = await s.request('/api/projects/none/users', {}, cookie);

  assert.equal(res.status, 404);
});

void test('GET /api/projects/:project/users は PAT 認証でも 200 を返す', async () => {
  const s = await makeServer();
  const account = await s.addAccount('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const { token, tokenHash } = generateApiToken();
  await s.storage.createApiToken({
    id: ulid(s.clock.t * 1000), accountId: account.accountId, label: 'test', tokenHash, created: s.clock.t,
  });

  const res = await s.request('/api/projects/proj/users', {
    headers: { 'x-personal-access-token': token },
  });

  assert.equal(res.status, 200);
});
