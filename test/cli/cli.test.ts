import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, runExport, runImport, runInit, runReindex, runUserAdd } from '../../src/cli/commands.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/cosense-export.json', import.meta.url));
const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'knot-cli-'));

void test('init は knot.db と files/ を作る', async () => {
  const dir = tmp();
  const msg = await runInit(dir);
  assert.match(msg, /initialized/);
  assert.ok(existsSync(join(dir, 'knot.db')));
  assert.ok(existsSync(join(dir, 'files')));
});

void test('import → export → reindex が通る', async () => {
  const dir = tmp();
  await runInit(dir);
  const imported = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(imported, /3 created/);
  const json = await runExport(dir, 'sandbox', 'full', null);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const exp = JSON.parse(json) as { name: string; pages: unknown[] };
  assert.equal(exp.name, 'sandbox');
  assert.equal(exp.pages.length, 3);
  const again = await runImport(dir, 'sandbox', FIXTURE, 'skip');
  assert.match(again, /3 skipped/);
  const reindexed = await runReindex(dir, 'sandbox');
  assert.match(reindexed, /reindexed 3 pages/);
});

void test('export --out はファイルに書き、reindex は未知プロジェクトを拒否する', async () => {
  const dir = tmp();
  await runInit(dir);
  await runImport(dir, 'sandbox', FIXTURE, 'skip');
  const outFile = join(dir, 'out.json');
  const msg = await runExport(dir, 'sandbox', 'import', outFile);
  assert.match(msg, /3 pages/);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const exp = JSON.parse(
    (await import('node:fs')).readFileSync(outFile, 'utf8'),
  ) as { pages: { lines: unknown[] }[] };
  assert.equal(typeof exp.pages[0]!.lines[0], 'string');
  await assert.rejects(runReindex(dir, 'nope'), /unknown project/);
});

void test('user add がユーザーを作り、同名の再実行は失敗する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-cli-'));
  await runInit(dir);
  const out = await runUserAdd(dir, 'alice', 'Alice', true, 'pw12345678');
  assert.match(out, /alice/);
  await assert.rejects(runUserAdd(dir, 'alice', null, false, 'other-pass'), /already exists/);
});

void test('user add は短いパスワードと不正な名前を拒否する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-cli-'));
  await runInit(dir);
  await assert.rejects(runUserAdd(dir, 'alice', null, false, 'short'), CliError);
  await assert.rejects(runUserAdd(dir, 'Bad Name!', null, false, 'pw12345678'), CliError);
});

void test('CLI 実行ファイルとして通しで動く（spawn）', () => {
  const dir = tmp();
  execFileSync(process.execPath, [MAIN, 'init', '--data', dir], { stdio: 'pipe' });
  execFileSync(process.execPath, [MAIN, 'import', '--data', dir, '--project', 'sandbox', FIXTURE], { stdio: 'pipe' });
  const out = execFileSync(process.execPath, [MAIN, 'export', '--data', dir, '--project', 'sandbox'], {
    stdio: 'pipe',
  }).toString();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  assert.equal((JSON.parse(out) as { pages: unknown[] }).pages.length, 3);
  // 未知コマンドは exit code 1
  assert.throws(() => execFileSync(process.execPath, [MAIN, 'bogus', '--data', dir], { stdio: 'pipe' }));
  // 余分な positional 引数は黙って無視せず拒否する
  assert.throws(() =>
    execFileSync(process.execPath, [MAIN, 'import', '--data', dir, '--project', 'sandbox', FIXTURE, FIXTURE], {
      stdio: 'pipe',
    }),
  );
});
