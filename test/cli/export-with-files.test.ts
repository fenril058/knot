import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import { runExport, runImport, runInit } from '../../src/cli/commands.ts';
import { readZip } from '../helpers/zip.ts';

const FIXTURE = fileURLToPath(new URL('../fixtures/cosense-export.json', import.meta.url));
const MAIN = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'knot-export-files-cli-'));

async function setup() {
  const dataDir = tmp();
  await runInit(dataDir);
  await runImport(dataDir, 'sandbox', FIXTURE, 'skip');
  const storage = new SqliteStorage(openDatabase(join(dataDir, 'knot.db')));
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const id = 'attachment-1';
  await storage.createAttachment({
    id, projectId: project.id, filename: 'hello.txt', contentType: 'text/plain', size: 5,
    sha256: 'a'.repeat(64), userId: 'u1', created: 1760000000,
  });
  await storage.close();
  writeFileSync(join(dataDir, 'files', id), 'hello');
  return { dataDir, id };
}

test('runExport は添付同梱 zip を出力する', async () => {
  const { dataDir, id } = await setup();
  const out = join(dataDir, 'export.zip');
  const message = await runExport(dataDir, 'sandbox', 'full', out, true);
  assert.match(message, /exported 3 pages and 1 files/);
  const entries = readZip((await import('node:fs')).readFileSync(out));
  assert.equal(entries.find((entry) => entry.name === `files/${id}`)?.data.toString(), 'hello');
});

test('knot export --with-files --out は zip を出力する', async () => {
  const { dataDir, id } = await setup();
  const out = join(dataDir, 'export.zip');
  const message = execFileSync(
    process.execPath,
    [MAIN, 'export', '--data', dataDir, '--project', 'sandbox', '--with-files', '--out', out],
    { stdio: 'pipe' },
  ).toString();
  assert.match(message, /exported 3 pages and 1 files/);
  const entries = readZip((await import('node:fs')).readFileSync(out));
  assert.equal(entries.find((entry) => entry.name === `files/${id}`)?.data.toString(), 'hello');
});

test('--with-files は --out なしと --format import との併用を拒否する', async () => {
  const { dataDir } = await setup();
  assert.throws(() => execFileSync(
    process.execPath,
    [MAIN, 'export', '--data', dataDir, '--project', 'sandbox', '--with-files'],
    { stdio: 'pipe' },
  ));
  assert.throws(() => execFileSync(
    process.execPath,
    [MAIN, 'export', '--data', dataDir, '--project', 'sandbox', '--with-files', '--format', 'import', '--out', 'x.zip'],
    { stdio: 'pipe' },
  ));
});
