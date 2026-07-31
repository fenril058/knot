import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage } from '../helpers/storage.ts';
import { StorageError } from '../../src/storage/types.ts';

const now = 1700000000;

void test('addUser と getUserByName / getUserById', async () => {
  const { storage } = makeStorage();
  const result = await storage.addUser(
    { id: 'U1', name: 'alice', displayName: 'Alice', passwordHash: 'h1', isAdmin: true },
    now,
  );
  assert.deepEqual(result, { kind: 'created', id: 'U1' });
  const byName = await storage.getUserByName('alice');
  assert.equal(byName!.id, 'U1');
  assert.equal(byName!.passwordHash, 'h1');
  assert.equal(byName!.isAdmin, true);
  const byId = await storage.getUserById('U1');
  assert.equal(byId!.name, 'alice');
  assert.equal(await storage.getUserByName('nobody'), null);
});

void test('パスワードなしの同名ユーザーはパスワード付与で昇格する', async () => {
  const { storage } = makeStorage();
  await storage.upsertDisplayUser({ id: 'U1', name: 'alice', displayName: 'Alice' }, now);
  const result = await storage.addUser(
    { id: 'U2', name: 'alice', displayName: 'Alice A', passwordHash: 'h1', isAdmin: false },
    now,
  );
  assert.deepEqual(result, { kind: 'claimed', id: 'U1' }); // ID は既存のまま
  const user = await storage.getUserByName('alice');
  assert.equal(user!.passwordHash, 'h1');
  assert.equal(user!.displayName, 'Alice A');
});

void test('パスワードありの同名ユーザーへの addUser は StorageError', async () => {
  const { storage } = makeStorage();
  await storage.addUser({ id: 'U1', name: 'alice', displayName: 'A', passwordHash: 'h1', isAdmin: false }, now);
  await assert.rejects(
    storage.addUser({ id: 'U2', name: 'alice', displayName: 'B', passwordHash: 'h2', isAdmin: false }, now),
    StorageError,
  );
});

void test('セッションの作成・取得・削除', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  const s = await storage.getSession('s1', now);
  assert.equal(s!.userId, 'U1');
  await storage.deleteSession('s1');
  assert.equal(await storage.getSession('s1', now), null);
});

void test('期限切れセッションは取得時に削除されて null', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  assert.equal(await storage.getSession('s1', now + 100), null);
  // 期限を戻しても復活しない（行が消えている）
  await storage.refreshSession('s1', now + 1000);
  assert.equal(await storage.getSession('s1', now), null);
});

void test('refreshSession で期限が延びる', async () => {
  const { storage } = makeStorage();
  await storage.createSession({ id: 's1', userId: 'U1', expires: now + 100, created: now });
  await storage.refreshSession('s1', now + 5000);
  const s = await storage.getSession('s1', now + 1000);
  assert.equal(s!.expires, now + 5000);
});
