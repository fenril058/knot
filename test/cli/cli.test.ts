import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExport, runImport, runInit, runReindex } from '../../src/cli/commands.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/cosense-export.json', import.meta.url));
const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'knot-cli-'));

test('init は knot.db と files/ を作る', async () => {
  const dir = tmp();
  const msg = await runInit(dir);
  assert.match(msg, /initialized/);
  assert.ok(existsSync(join(dir, 'knot.db')));
  assert.ok(existsSync(join(dir, 'files')));
});

test('import → export → reindex が通る', async () => {
  const dir = tmp();
  await runInit(dir);
  const imported = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(imported, /3 created/);
  const json = await runExport(dir, 'sandbox', 'full', null);
  const exp = JSON.parse(json) as { name: string; pages: unknown[] };
  assert.equal(exp.name, 'sandbox');
  assert.equal(exp.pages.length, 3);
  const again = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(again, /3 skipped/);
  const reindexed = await runReindex(dir, 'sandbox');
  assert.match(reindexed, /reindexed 3 pages/);
});

test('export --out はファイルに書き、reindex は未知プロジェクトを拒否する', async () => {
  const dir = tmp();
  await runInit(dir);
  await runImport(dir, 'sandbox', FIXTURE, 'skip');
  const outFile = join(dir, 'out.json');
  const msg = await runExport(dir, 'sandbox', 'import', outFile);
  assert.match(msg, /3 pages/);
  const exp = JSON.parse(
    (await import('node:fs')).readFileSync(outFile, 'utf8'),
  ) as { pages: { lines: unknown[] }[] };
  assert.equal(typeof exp.pages[0].lines[0], 'string');
  await assert.rejects(runReindex(dir, 'nope'), /unknown project/);
});

test('CLI 実行ファイルとして通しで動く（spawn）', () => {
  const dir = tmp();
  execFileSync(process.execPath, [MAIN, 'init', '--data', dir], { stdio: 'pipe' });
  execFileSync(process.execPath, [MAIN, 'import', '--data', dir, '--project', 'sandbox', FIXTURE], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [MAIN, 'export', '--data', dir, '--project', 'sandbox'], {
    stdio: 'pipe',
  }).toString();
  assert.equal((JSON.parse(out) as { pages: unknown[] }).pages.length, 3);
  // 未知コマンドは exit code 1
  assert.throws(() => execFileSync(process.execPath, [MAIN, 'bogus', '--data', dir], { stdio: 'pipe' }));
});
