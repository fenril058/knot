import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCosense } from '../../src/storage/import.ts';
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

test('各プロジェクトのサブディレクトリへ読める zip を一時ファイル経由で書く', async () => {
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

test('各プロジェクトで新しい keep 世代だけを残す', async () => {
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

test('prefix が共通するプロジェクトの世代を別々に管理する', async () => {
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

test('同一秒の後続実行が最新スナップショットで置換する', async () => {
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
  const json = JSON.parse(readZip(await readFile(result.written[0]!))[0]!.data.toString()) as { pages: { title: string }[] };
  assert.deepEqual(json.pages.map((page) => page.title).toSorted(), ['First', 'Second']);
  await storage.close();
});

test('添付が欠落したプロジェクトを記録して他プロジェクトを続行する', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  mkdirSync(join(dataDir, 'files'));
  const dir = mkdtempSync(join(tmpdir(), 'knot-auto-export-out-'));
  const { storage } = makeStorage();
  await addProject(storage, 'bad');
  await addProject(storage, 'good');
  const bad = (await storage.getProject('bad'))!;
  const attachment: Attachment = {
    id: 'missing-file', projectId: bad.id, filename: 'missing.txt', contentType: 'text/plain', size: 1,
    sha256: 'a'.repeat(64), userId: 'user-bad', created: NOW,
  };
  await storage.createAttachment(attachment);
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });

  const result = await runAutoExportOnce(storage, dataDir, { dir, keep: 7 }, NOW);

  assert.deepEqual(result.written, [join(dir, 'good', '20251009-085500.zip')]);
  assert.equal(errors.length, 1);
  await storage.close();
});

test('起動直後と周期ごとに実行し、実行中は skip し、stop 後は実行しない', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-auto-export-data-'));
  const { storage } = makeStorage();
  await addProject(storage, 'alpha');
  const originalListProjects = storage.listProjects.bind(storage);
  let calls = 0;
  let release!: () => void;
  let blocked = new Promise<void>((resolve) => { release = resolve; });
  storage.listProjects = async () => {
    calls++;
    await blocked;
    return originalListProjects();
  };
  const config = { ...defaultConfig(dataDir), autoExportDir: 'exports', autoExportIntervalHours: 1 };

  const handle = startAutoExport({ storage, dataDir, config, now: () => NOW });
  assert.equal(calls, 1);
  t.mock.timers.tick(3_600_000);
  assert.equal(calls, 1);
  release();
  const firstExport = join(dataDir, 'exports', 'alpha', '20251009-085500.zip');
  for (let i = 0; i < 100 && !existsSync(firstExport); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(existsSync(firstExport), true);
  // ファイル確定後の世代管理と finally での実行中フラグ解除まで待つ。
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  blocked = Promise.resolve();
  t.mock.timers.tick(3_600_000);
  await Promise.resolve();
  assert.equal(calls, 2);
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  handle.stop();
  t.mock.timers.tick(3_600_000);
  assert.equal(calls, 2);
  await storage.close();
});
