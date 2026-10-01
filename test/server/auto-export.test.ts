import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCosense } from '../../src/application/importCosense.ts';
import { runAutoExportOnce, startAutoExport } from '../../src/server/autoExport.ts';
import { defaultConfig } from '../../src/server/config.ts';
import type { Attachment, Storage } from '../../src/storage/types.ts';
import { makeStorage } from '../helpers/storage.ts';
import { readZip } from '../helpers/zip.ts';

const NOW = 1_760_000_100;

async function addProject(storage: Storage, name: string, pageTitle = `${name} page`) {
  await importCosense(storage, {
    name,
    displayName: name,
    exported: NOW - 10,
    users: [{ id: `user-${name}`, name: `user-${name}`, displayName: name }],
    pages: [{ id: `page-${name}`, title: pageTitle, created: NOW - 5, updated: NOW - 5, lines: [pageTitle] }],
  }, { projectName: name, now: NOW - 1 });
}

function zipNames(dir: string, project: string): string[] {
  return readdirSync(join(dir, project)).filter((name) => name.endsWith('.zip')).toSorted();
}

void test('各プロジェクトのサブディレクトリへ読める zip を一時ファイル経由で書く', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'alpha');
  await addProject(storage, 'beta');

  const result = await runAutoExportOnce(storage, dataDir, { dir, keep: 7 }, NOW);

  assert.deepEqual(result.written, [join(dir, 'alpha', '20251009-085500.zip'), join(dir, 'beta', '20251009-085500.zip')]);
  assert.deepEqual(result.pruned, []);
  for (const project of ['alpha', 'beta']) {
    assert.deepEqual(readdirSync(join(dir, project)), ['20251009-085500.zip']);
    assert.equal(readZip(await readFile(result.written.find((path) => path.includes(`/${project}/`))!))[0]?.name, `${project}.json`);
  }
  await storage.close();
});

void test('各プロジェクトで新しい keep 世代だけを残す', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'alpha');
  await addProject(storage, 'beta');
  await runAutoExportOnce(storage, dataDir, { dir, keep: 2 }, NOW);
  await runAutoExportOnce(storage, dataDir, { dir, keep: 2 }, NOW + 1);
  const result = await runAutoExportOnce(storage, dataDir, { dir, keep: 2 }, NOW + 2);

  for (const project of ['alpha', 'beta']) assert.deepEqual(zipNames(dir, project), ['20251009-085501.zip', '20251009-085502.zip']);
  assert.deepEqual(result.pruned, [join(dir, 'alpha', '20251009-085500.zip'), join(dir, 'beta', '20251009-085500.zip')]);
  await storage.close();
});

void test('prefix が共通するプロジェクトの世代を別々に管理する', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'a');
  await addProject(storage, 'a-b');
  await runAutoExportOnce(storage, dataDir, { dir, keep: 1 }, NOW);
  await runAutoExportOnce(storage, dataDir, { dir, keep: 1 }, NOW + 1);

  assert.deepEqual(zipNames(dir, 'a'), ['20251009-085501.zip']);
  assert.deepEqual(zipNames(dir, 'a-b'), ['20251009-085501.zip']);
  await storage.close();
});

void test('同一秒の後続実行が最新スナップショットで置換する', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'alpha', 'First');
  await runAutoExportOnce(storage, dataDir, { dir, keep: 7 }, NOW);
  await importCosense(storage, {
    name: 'alpha', displayName: 'alpha', exported: NOW,
    users: [{ id: 'user-alpha', name: 'user-alpha', displayName: 'alpha' }],
    pages: [
      { id: 'page-alpha', title: 'First', created: NOW - 5, updated: NOW, lines: ['First'] },
      { id: 'second-page', title: 'Second', created: NOW, updated: NOW, lines: ['Second'] },
    ],
  }, { projectName: 'alpha', now: NOW, onConflict: 'overwrite' });
  const result = await runAutoExportOnce(storage, dataDir, { dir, keep: 7 }, NOW);

  assert.equal(zipNames(dir, 'alpha').length, 1);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const json = JSON.parse(readZip(await readFile(result.written[0]!))[0]!.data.toString()) as { pages: { title: string }[] };
  assert.deepEqual(json.pages.map((page) => page.title).toSorted(), ['First', 'Second']);
  await storage.close();
});

void test('添付が欠落したプロジェクトを記録して他プロジェクトを続行する', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  mkdirSync(join(dataDir, 'files'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'bad');
  await addProject(storage, 'good');
  const bad = (await storage.getProject('bad'))!;
  const attachment: Attachment = {
    id: 'missing-file', projectId: bad.id, filename: 'missing.txt', contentType: 'text/plain', size: 1,
    sha256: 'a'.repeat(64), actorId: 'user-bad', created: NOW,
  };
  await storage.createAttachment(attachment);
  mkdirSync(join(dir, 'bad'));
  writeFileSync(join(dir, 'bad', '20251009-085500.zip.tmp'), 'partial');
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });

  const result = await runAutoExportOnce(storage, dataDir, { dir, keep: 7 }, NOW);

  assert.deepEqual(result.written, [join(dir, 'good', '20251009-085500.zip')]);
  assert.equal(errors.length, 1);
  assert.deepEqual(readdirSync(join(dir, 'bad')), []);
  await storage.close();
});

void test('起動直後と周期ごとに実行し、実行中は skip し、stop 後は実行しない', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { storage } = makeStorage();
  const dataDir = join(tmpdir(), 'knot-auto-export-schedule');
  const config = { ...defaultConfig(dataDir), autoExportDir: 'exports', autoExportIntervalHours: 1 };
  config.autoExportKeep = 3;
  // 実行の完了を test から決められるよう、export 本体は差し替える。export 自体の挙動は上の test で見る。
  const runs: { args: Parameters<typeof runAutoExportOnce>; finish: () => void }[] = [];
  const runOnce: typeof runAutoExportOnce = (...args) => new Promise((resolve) => {
    runs.push({ args, finish: () => resolve({ written: [], pruned: [] }) });
  });
  // 完了から finally で実行中が解除されるまでの Promise の後処理を流す。
  // setImmediate は mock 対象外（apis: ['setInterval']）で、I/O を待たないので 1 回で足りる。
  const finish = async (index: number) => {
    runs[index]!.finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const handle = startAutoExport({ storage, dataDir, config, now: () => NOW, runOnce });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0]!.args, [storage, dataDir, { dir: join(dataDir, 'exports'), keep: 3 }, NOW]);
  await finish(0);

  // 完了済みなら、ちょうど 1 周期後に次が始まる。
  t.mock.timers.tick(3_599_999);
  assert.equal(runs.length, 1);
  t.mock.timers.tick(1);
  assert.equal(runs.length, 2);

  // 実行中に来た周期は skip し、完了後のちょうど次の周期で始まる。
  t.mock.timers.tick(3_600_000);
  assert.equal(runs.length, 2);
  await finish(1);
  t.mock.timers.tick(3_599_999);
  assert.equal(runs.length, 2);
  t.mock.timers.tick(1);
  assert.equal(runs.length, 3);

  await finish(2);
  handle.stop();
  t.mock.timers.tick(10 * 3_600_000);
  assert.equal(runs.length, 3);
  await storage.close();
});
