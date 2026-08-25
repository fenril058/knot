import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { BadCommitError, type CommitInput } from '../../src/storage/types.ts';

async function setup() {
  const { db, storage } = makeStorage();
  const project = await storage.ensureProject('wiki', 1000);
  const first: CommitInput = {
    projectId: project.id,
    pageId: 'pg1',
    commitId: 'c1',
    baseVersion: 0,
    ops: [{ type: 'insert', id: 'l1', after: '_head', text: 'T' }],
    actorId: 'u1',
    now: 2000,
  };
  await storage.commit(first);
  return { db, storage, project, first };
}

void test('同一 commitId 同一内容の再送は最初の version を返し、二度適用しない', async () => {
  const { db, storage, first } = await setup();
  const replay = await storage.commit(first);
  assert.deepEqual(replay, { kind: 'applied', version: 1 });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const count = (db.prepare('SELECT count(*) AS c FROM commits').get() as { c: number }).c;
  assert.equal(count, 1);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const version = (db.prepare('SELECT version FROM pages WHERE id = ?').get('pg1') as { version: number }).version;
  assert.equal(version, 1);
  await storage.close();
});

void test('他のコミットが挟まった後の再送でも conflict にならず最初の version を返す', async () => {
  const { storage, project, first } = await setup();
  await storage.commit({
    projectId: project.id, pageId: 'pg1', commitId: 'c2', baseVersion: 1,
    ops: [{ type: 'insert', id: 'l2', after: 'l1', text: 'x' }],
    actorId: 'u2', now: 3000,
  });
  const replay = await storage.commit(first);
  assert.deepEqual(replay, { kind: 'applied', version: 1 });
  await storage.close();
});

void test('同一 commitId で内容が異なる要求は BadCommitError', async () => {
  const { storage, first } = await setup();
  await assert.rejects(
    storage.commit({ ...first, ops: [{ type: 'insert', id: 'l1', after: '_head', text: '別内容' }] }),
    BadCommitError,
  );
  await storage.close();
});
