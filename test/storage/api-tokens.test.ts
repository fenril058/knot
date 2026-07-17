import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { makeStorage } from '../helpers/storage.ts';

test('API token の発行、検索、一覧、削除ができる', async () => {
  const { storage } = makeStorage();
  const now = 1_700_000_000;
  const user = await storage.addUser(
    { id: ulid(now * 1000), name: 'alice', displayName: 'Alice', passwordHash: 'hash', isAdmin: true },
    now,
  );
  const first = { id: ulid(now * 1000), userId: user.id, label: 'first', tokenHash: 'hash-1', created: now };
  const second = {
    id: ulid(now * 1000 + 1),
    userId: user.id,
    label: 'second',
    tokenHash: 'hash-2',
    created: now,
  };

  await storage.createApiToken(first);
  await storage.createApiToken(second);

  const authUser = await storage.getUserByApiTokenHash(first.tokenHash);
  assert.equal(authUser?.id, user.id);
  assert.equal(authUser?.name, 'alice');
  assert.equal(await storage.getUserByApiTokenHash('unknown'), null);
  assert.deepEqual(await storage.listApiTokens(user.id), [
    { id: first.id, userId: user.id, label: 'first', created: now },
    { id: second.id, userId: user.id, label: 'second', created: now },
  ]);

  assert.equal(await storage.deleteApiToken(first.id), true);
  assert.equal(await storage.deleteApiToken(first.id), false);
  assert.equal(await storage.getUserByApiTokenHash(first.tokenHash), null);
  assert.deepEqual(await storage.listApiTokens(user.id), [
    { id: second.id, userId: user.id, label: 'second', created: now },
  ]);
  await storage.close();
});

test('token_hash の重複を拒否する', async () => {
  const { storage } = makeStorage();
  const now = 1_700_000_000;
  const user = await storage.addUser(
    { id: ulid(now * 1000), name: 'alice', displayName: 'Alice', passwordHash: 'hash', isAdmin: false },
    now,
  );
  await storage.createApiToken({ id: ulid(now * 1000), userId: user.id, label: 'one', tokenHash: 'same', created: now });

  await assert.rejects(
    storage.createApiToken({
      id: ulid(now * 1000 + 1),
      userId: user.id,
      label: 'two',
      tokenHash: 'same',
      created: now + 1,
    }),
  );
  await storage.close();
});
