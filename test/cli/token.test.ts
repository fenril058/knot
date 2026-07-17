import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashApiToken } from '../../src/server/apiToken.ts';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';

const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'knot-token-'));

test('token add、list、revoke が通る', async () => {
  const dir = tmp();
  execFileSync(process.execPath, [MAIN, 'init', '--data', dir]);
  execFileSync(process.execPath, [MAIN, 'user', 'add', '--data', dir, '--name', 'alice'], {
    input: 'pw12345678',
  });

  const token = execFileSync(
    process.execPath,
    [MAIN, 'token', 'add', '--data', dir, '--user', 'alice'],
    { encoding: 'utf8' },
  ).trim();
  assert.match(token, /^knot_[A-Za-z0-9_-]+$/);

  const storage = new SqliteStorage(openDatabase(join(dir, 'knot.db')));
  const user = await storage.getUserByApiTokenHash(hashApiToken(token));
  assert.equal(user?.name, 'alice');
  const [issued] = await storage.listApiTokens(user!.id);
  assert.ok(issued);

  const list = execFileSync(process.execPath, [MAIN, 'token', 'list', '--data', dir, '--user', 'alice'], {
    encoding: 'utf8',
  });
  assert.match(list, /default/);
  assert.match(list, new RegExp(issued.id));
  assert.doesNotMatch(list, new RegExp(token));

  execFileSync(process.execPath, [MAIN, 'token', 'revoke', '--data', dir, '--id', issued.id]);
  assert.equal(await storage.getUserByApiTokenHash(hashApiToken(token)), null);
  await storage.close();
});

test('token add は未知ユーザーを exit code 1 で拒否する', () => {
  const dir = tmp();
  execFileSync(process.execPath, [MAIN, 'init', '--data', dir]);

  assert.throws(
    () => execFileSync(process.execPath, [MAIN, 'token', 'add', '--data', dir, '--user', 'nobody']),
    (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 1,
  );
});
