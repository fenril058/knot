import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from '../../src/cli/sync/config.ts';
import {
  clearPendingPullRename,
  loadPendingPullRename,
  loadState,
  savePendingPullRename,
  saveState,
} from '../../src/cli/sync/state.ts';
import { CliError } from '../../src/cli/commands.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'knot-sync-'));
}

void test('normalizeBaseUrl: 末尾スラッシュを除去し origin+path を返す', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeBaseUrl('https://wiki.example.com/knot/'), 'https://wiki.example.com/knot');
});

void test('normalizeBaseUrl: userinfo・非 http(s)・query を拒否する', () => {
  assert.throws(() => normalizeBaseUrl('http://user:pw@host/'), CliError);
  assert.throws(() => normalizeBaseUrl('ftp://host/'), CliError);
  assert.throws(() => normalizeBaseUrl('http://host/?q=1'), CliError);
  assert.throws(() => normalizeBaseUrl('not a url'), CliError);
});

void test('config の round-trip', () => {
  const dir = tmp();
  try {
    writeSyncConfig(dir, { url: 'http://127.0.0.1:3000', project: 'notes' });
    assert.deepEqual(loadSyncConfig(dir), { url: 'http://127.0.0.1:3000', project: 'notes' });
  } finally { rmSync(dir, { recursive: true }); }
});

void test('loadSyncConfig: config が無ければ CliError', () => {
  const dir = tmp();
  try {
    assert.throws(() => loadSyncConfig(dir), CliError);
  } finally { rmSync(dir, { recursive: true }); }
});

void test('resolveToken: KNOT_TOKEN 優先、なければ .knot/token、どちらも無ければ CliError', () => {
  const dir = tmp();
  try {
    assert.throws(() => resolveToken(dir, {}), CliError);
    mkdirSync(join(dir, '.knot'), { recursive: true });
    writeFileSync(join(dir, '.knot', 'token'), 'knot_filetoken\n');
    assert.equal(resolveToken(dir, {}), 'knot_filetoken');
    assert.equal(resolveToken(dir, { KNOT_TOKEN: 'knot_envtoken' }), 'knot_envtoken');
  } finally { rmSync(dir, { recursive: true }); }
});

void test('state: 無ければ空、保存後は読み戻せる、tmp ファイルが残らない', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.knot'), { recursive: true });
    assert.deepEqual(loadState(dir), { pages: {} });
    const state = {
      pages: { p1: { title: 'Alpha', filename: 'Alpha.txt', version: 3, contentHash: 'sha256:ab' } },
    };
    saveState(dir, state);
    assert.deepEqual(loadState(dir), state);
    assert.deepEqual(readdirSync(join(dir, '.knot')).toSorted(), ['state.json']);
  } finally { rmSync(dir, { recursive: true }); }
});

void test('pull のリネーム中断記録をアトミックに保存し、完了後に削除する', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.knot'), { recursive: true });
    const pending = {
      pageId: 'p1',
      from: { title: 'Alpha', filename: 'Alpha.txt', version: 1, contentHash: 'sha256:old' },
      to: { title: 'Alpha2', filename: 'Alpha2.txt', version: 2, contentHash: 'sha256:new' },
    };
    assert.equal(loadPendingPullRename(dir), undefined);
    savePendingPullRename(dir, pending);
    assert.deepEqual(loadPendingPullRename(dir), pending);
    assert.deepEqual(readdirSync(join(dir, '.knot')).toSorted(), ['pending-pull-rename.json']);
    clearPendingPullRename(dir);
    assert.equal(loadPendingPullRename(dir), undefined);
    assert.equal(existsSync(join(dir, '.knot', 'pending-pull-rename.json.tmp')), false);
  } finally { rmSync(dir, { recursive: true }); }
});
