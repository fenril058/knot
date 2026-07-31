import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStorage } from '../helpers/storage.ts';
import { readZip } from '../helpers/zip.ts';
import { importCosense } from '../../src/storage/import.ts';
import { buildExportZip } from '../../src/storage/exportZip.ts';
import { StorageError, type Attachment } from '../../src/storage/types.ts';

const NOW = 1760000100;

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-export-zip-'));
  mkdirSync(join(dataDir, 'files'));
  const { storage } = makeStorage();
  await importCosense(
    storage,
    {
      name: 'source',
      displayName: 'Source',
      exported: NOW - 100,
      users: [{ id: 'u1', name: 'alice', displayName: 'Alice' }],
      pages: [
        { id: 'p1', title: 'One', created: NOW - 20, updated: NOW - 20, lines: ['One'] },
        { id: 'p2', title: 'Two', created: NOW - 10, updated: NOW - 10, lines: ['Two'] },
      ],
    },
    { projectName: 'project', now: NOW - 1 },
  );
  const project = await storage.getProject('project');
  assert.ok(project);
  const attachments: Attachment[] = [
    {
      id: 'file-b', projectId: project.id, filename: 'b.txt', contentType: 'text/plain', size: 3,
      sha256: 'b'.repeat(64), userId: 'u1', created: NOW - 2,
    },
    {
      id: 'file-a', projectId: project.id, filename: 'a.txt', contentType: 'text/plain', size: 3,
      sha256: 'a'.repeat(64), userId: 'u1', created: NOW - 3,
    },
  ];
  for (const attachment of attachments) await storage.createAttachment(attachment);
  return { dataDir, storage, attachments };
}

void test('full export とプロジェクトの添付ファイルを zip に同梱する', async () => {
  const { dataDir, storage, attachments } = await setup();
  writeFileSync(join(dataDir, 'files', attachments[0]!.id), 'BBB');
  writeFileSync(join(dataDir, 'files', attachments[1]!.id), 'AAA');

  const entries = readZip(await buildExportZip(storage, dataDir, 'project', NOW));
  assert.deepEqual(entries.map((entry) => entry.name), ['project.json', 'files/file-a', 'files/file-b']);
  const json = entries.find((entry) => entry.name === 'project.json');
  assert.ok(json);
  const exp = JSON.parse(json.data.toString('utf8')) as { pages: unknown[] };
  assert.equal(exp.pages.length, 2);
  assert.equal(entries.find((entry) => entry.name === 'files/file-a')?.data.toString(), 'AAA');
  assert.equal(entries.find((entry) => entry.name === 'files/file-b')?.data.toString(), 'BBB');
  await storage.close();
});

void test('添付レコードの実ファイルが欠落していれば拒否する', async () => {
  const { dataDir, storage } = await setup();
  await assert.rejects(buildExportZip(storage, dataDir, 'project', NOW), StorageError);
  await storage.close();
});

void test('未知プロジェクトを拒否する', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knot-export-zip-'));
  const { storage } = makeStorage();
  await assert.rejects(buildExportZip(storage, dataDir, 'missing', NOW), StorageError);
  await storage.close();
});
