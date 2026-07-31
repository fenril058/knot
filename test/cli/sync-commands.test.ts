import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../src/cli/sync/commands.ts';
import { saveState } from '../../src/cli/sync/state.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'knot-sync-'));
}

void test('sync init: config を書き、gitignore 案内を出す', async () => {
  const dir = tmp();
  try {
    const result = await runSync(['init', dir, '--url', 'http://127.0.0.1:3000/', '--project', 'notes']);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /\.knot/); // gitignore 案内
    const config = JSON.parse(readFileSync(join(dir, '.knot', 'config.json'), 'utf8'));
    assert.deepEqual(config, { url: 'http://127.0.0.1:3000', project: 'notes' }); // 末尾スラッシュ正規化
  } finally { rmSync(dir, { recursive: true }); }
});

void test('sync init: 不正 URL は exitCode 2', async () => {
  const dir = tmp();
  try {
    const result = await runSync(['init', dir, '--url', 'ftp://x/', '--project', 'notes']);
    assert.equal(result.exitCode, 2);
  } finally { rmSync(dir, { recursive: true }); }
});

void test('sync status（ローカルのみ）: modified / new / missing を一覧する', async () => {
  const dir = tmp();
  try {
    await runSync(['init', dir, '--url', 'http://h', '--project', 'notes']);
    saveState(dir, {
      pages: {
        p1: { title: 'Alpha', filename: 'Alpha.txt', version: 1, contentHash: 'sha256:other' },
        p2: { title: 'Gone', filename: 'Gone.txt', version: 1, contentHash: 'sha256:x' },
      },
    });
    writeFileSync(join(dir, 'Alpha.txt'), 'Alpha\nmodified body\n');
    writeFileSync(join(dir, 'New Page.txt'), 'New Page\nhello\n');
    const result = await runSync(['status', '--dir', dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /modified:\s+Alpha\.txt/);
    assert.match(result.output, /new:\s+New Page\.txt/);
    assert.match(result.output, /missing:\s+Gone\.txt/);
  } finally { rmSync(dir, { recursive: true }); }
});

void test('sync: 未知サブコマンドと config 不在は exitCode 2', async () => {
  const dir = tmp();
  try {
    assert.equal((await runSync(['bogus'])).exitCode, 2);
    assert.equal((await runSync(['status', '--dir', dir])).exitCode, 2); // init していない
  } finally { rmSync(dir, { recursive: true }); }
});
