import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { StorageError } from '../../src/storage/types.ts';

const now = 1_700_000_000;

void test('addAccount は別 ID の Account と Actor を作成する', async () => {
  const { storage } = makeStorage();
  const result = await storage.addAccount({
    id: 'account-1',
    actor: { id: 'actor-1', name: 'alice', displayName: 'Alice' },
    name: 'alice', passwordHash: 'h1', isAdmin: true,
  }, now);

  assert.deepEqual(result, { accountId: 'account-1', actorId: 'actor-1' });
  const byName = await storage.getAccountByName('alice');
  assert.equal(byName?.id, 'account-1');
  assert.equal(byName?.actorId, 'actor-1');
  assert.equal(byName?.passwordHash, 'h1');
  assert.equal(byName?.isAdmin, true);
  assert.deepEqual(await storage.getActorById('actor-1'), {
    id: 'actor-1', name: 'alice', displayName: 'Alice',
  });
  assert.equal(await storage.getAccountByName('nobody'), null);
});

void test('同名 imported Actor は新規 Account に暗黙に関連づけない', async () => {
  const { storage } = makeStorage();
  await storage.upsertActor({ id: 'imported-actor', name: 'alice', displayName: 'Imported Alice' }, now);

  const result = await storage.addAccount({
    id: 'account-1',
    actor: { id: 'account-actor', name: 'alice', displayName: 'Local Alice' },
    name: 'alice', passwordHash: 'h1', isAdmin: false,
  }, now);

  assert.deepEqual(result, { accountId: 'account-1', actorId: 'account-actor' });
  assert.equal((await storage.getAccountByName('alice'))?.actorId, 'account-actor');
  assert.equal((await storage.getActorById('imported-actor'))?.displayName, 'Imported Alice');
});

void test('同名 Account への addAccount は StorageError', async () => {
  const { storage } = makeStorage();
  await storage.addAccount({
    id: 'account-1', actor: { id: 'actor-1', name: 'alice', displayName: 'A' },
    name: 'alice', passwordHash: 'h1', isAdmin: false,
  }, now);
  await assert.rejects(storage.addAccount({
    id: 'account-2', actor: { id: 'actor-2', name: 'alice', displayName: 'B' },
    name: 'alice', passwordHash: 'h2', isAdmin: false,
  }, now), StorageError);
});

void test('Account の名前変更と削除は Actor を変更または削除しない', async () => {
  const { db, storage } = makeStorage();
  await storage.addAccount({
    id: 'account-1', actor: { id: 'actor-1', name: 'alice', displayName: 'Alice' },
    name: 'alice', passwordHash: 'h1', isAdmin: false,
  }, now);
  const project = await storage.ensureProject('project', now);
  await storage.commit({
    projectId: project.id,
    pageId: 'page',
    commitId: 'commit',
    baseVersion: 0,
    ops: [{ type: 'insert', id: 'line', after: '_head', text: 'Page' }],
    actorId: 'actor-1',
    now,
  });

  db.prepare("UPDATE accounts SET name = 'alice-renamed' WHERE id = 'account-1'").run();
  assert.equal((await storage.getActorById('actor-1'))?.name, 'alice');
  assert.equal((await storage.getPageAuthors('page')).user?.displayName, 'Alice');
  db.prepare("DELETE FROM accounts WHERE id = 'account-1'").run();
  assert.deepEqual(await storage.getActorById('actor-1'), {
    id: 'actor-1', name: 'alice', displayName: 'Alice',
  });
});

async function storageWithAccount() {
  const result = makeStorage();
  await result.storage.addAccount({
    id: 'account-1', actor: { id: 'actor-1', name: 'a', displayName: 'A' },
    name: 'a', passwordHash: 'h', isAdmin: false,
  }, now);
  return result.storage;
}

void test('セッションの作成・取得・削除', async () => {
  const storage = await storageWithAccount();
  await storage.createSession({ id: 's1', accountId: 'account-1', expires: now + 100, created: now });
  assert.equal((await storage.getSession('s1', now))?.accountId, 'account-1');
  await storage.deleteSession('s1');
  assert.equal(await storage.getSession('s1', now), null);
});

void test('期限切れセッションは取得時に削除されて null', async () => {
  const storage = await storageWithAccount();
  await storage.createSession({ id: 's1', accountId: 'account-1', expires: now + 100, created: now });
  assert.equal(await storage.getSession('s1', now + 100), null);
  await storage.refreshSession('s1', now + 1000);
  assert.equal(await storage.getSession('s1', now), null);
});

void test('refreshSession で期限が延びる', async () => {
  const storage = await storageWithAccount();
  await storage.createSession({ id: 's1', accountId: 'account-1', expires: now + 100, created: now });
  await storage.refreshSession('s1', now + 5000);
  assert.equal((await storage.getSession('s1', now + 1000))?.expires, now + 5000);
});
