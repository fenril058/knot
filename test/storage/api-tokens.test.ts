import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { makeStorage } from '../helpers/storage.ts';

void test('API token の発行、検索、一覧、削除ができる', async () => {
  const { storage } = makeStorage();
  const now = 1_700_000_000;
  const account = await storage.addAccount(
    {
      id: ulid(now * 1000),
      actor: { id: ulid(now * 1000), name: 'alice', displayName: 'Alice' },
      name: 'alice', passwordHash: 'hash', isAdmin: true,
    },
    now,
  );
  const first = { id: ulid(now * 1000), accountId: account.accountId, label: 'first', tokenHash: 'hash-1', created: now };
  const second = {
    id: ulid(now * 1000 + 1),
    accountId: account.accountId,
    label: 'second',
    tokenHash: 'hash-2',
    created: now,
  };

  await storage.createApiToken(first);
  await storage.createApiToken(second);

  const authenticated = await storage.getAccountByApiTokenHash(first.tokenHash);
  assert.equal(authenticated?.id, account.accountId);
  assert.equal(authenticated?.name, 'alice');
  assert.equal(await storage.getAccountByApiTokenHash('unknown'), null);
  assert.deepEqual(await storage.listApiTokens(account.accountId), [
    { id: first.id, accountId: account.accountId, label: 'first', created: now },
    { id: second.id, accountId: account.accountId, label: 'second', created: now },
  ]);

  assert.equal(await storage.deleteApiToken(first.id), true);
  assert.equal(await storage.deleteApiToken(first.id), false);
  assert.equal(await storage.getAccountByApiTokenHash(first.tokenHash), null);
  assert.deepEqual(await storage.listApiTokens(account.accountId), [
    { id: second.id, accountId: account.accountId, label: 'second', created: now },
  ]);
  await storage.close();
});

void test('token_hash の重複を拒否する', async () => {
  const { storage } = makeStorage();
  const now = 1_700_000_000;
  const account = await storage.addAccount(
    {
      id: ulid(now * 1000),
      actor: { id: ulid(now * 1000), name: 'alice', displayName: 'Alice' },
      name: 'alice', passwordHash: 'hash', isAdmin: false,
    },
    now,
  );
  await storage.createApiToken({ id: ulid(now * 1000), accountId: account.accountId, label: 'one', tokenHash: 'same', created: now });

  await assert.rejects(
    storage.createApiToken({
      id: ulid(now * 1000 + 1),
      accountId: account.accountId,
      label: 'two',
      tokenHash: 'same',
      created: now + 1,
    }),
  );
  await storage.close();
});
