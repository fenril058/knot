import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeStorage } from '../helpers/storage.ts';
import { importCosense } from '../../src/storage/import.ts';
import { exportCosense } from '../../src/storage/export.ts';
import { normalizeLines, parseExportFile, type CosenseLine } from '../../src/core/cosense.ts';
import { ulid } from '../../src/core/id.ts';

const FIXTURE_URL = new URL('../fixtures/cosense-export.json', import.meta.url);
const loadFixture = () => JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as unknown;

type ObjectLine = Exclude<CosenseLine, string>;

const byTitle = <T extends { title: string }>(pages: readonly T[]): T[] =>
  pages.toSorted((a, b) => a.title.localeCompare(b.title));

void test('round-trip: インポート → エクスポートで意味が保存される', async () => {
  const { storage } = makeStorage();
  const data = loadFixture();
  await importCosense(storage, data, { projectName: 'sandbox', now: 1760000000 });
  const out = await exportCosense(storage, 'sandbox', 'full', 1760000001);
  const src = parseExportFile(data);

  assert.equal(out.name, 'sandbox');
  assert.equal(out.exported, 1760000001);
  assert.equal(out.pages.length, src.pages.length);
  for (const page of src.pages) {
    const got = out.pages.find((p) => p.title === page.title);
    assert.ok(got, `${page.title} が出力にない`);
    const srcLines = normalizeLines(page);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const gotLines = got.lines as ObjectLine[];
    assert.deepEqual(gotLines.map((l) => l.text), srcLines.map((l) => l.text));
    srcLines.forEach((l, i) => {
      if (l.id !== null) assert.equal(gotLines[i]!.id, l.id);
      if (l.created !== null) assert.equal(gotLines[i]!.created, l.created);
      if (l.updated !== null) assert.equal(gotLines[i]!.updated, l.updated);
      if (l.userId !== null) assert.equal(gotLines[i]!.userId, l.userId);
    });
    if (page.id !== undefined) assert.equal(got.id, page.id);
    if (page.created !== undefined) assert.equal(got.created, page.created);
    if (page.updated !== undefined) assert.equal(got.updated, page.updated);
  }
  const userNames = (out.users ?? []).map((u) => u.name);
  assert.ok(userNames.includes('alice'));
  assert.ok(userNames.includes('bob'));
  await storage.close();
});

void test('export → import → export が安定する', async () => {
  const first = makeStorage();
  await importCosense(first.storage, loadFixture(), { projectName: 'sandbox', now: 1760000000 });
  const out1 = await exportCosense(first.storage, 'sandbox', 'full', 1760000001);
  await first.storage.close();

  const second = makeStorage();
  await importCosense(second.storage, out1, { projectName: 'sandbox', now: 1770000000 });
  const out2 = await exportCosense(second.storage, 'sandbox', 'full', 1760000001);
  await second.storage.close();

  assert.deepEqual(byTitle(out2.pages), byTitle(out1.pages));
});

void test('format=import は行を文字列配列で出す', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, loadFixture(), { projectName: 'sandbox', now: 1760000000 });
  const out = await exportCosense(storage, 'sandbox', 'import', 1760000001);
  for (const page of out.pages) {
    for (const line of page.lines) assert.equal(typeof line, 'string');
  }
  await storage.close();
});

void test('削除済みページはエクスポートに含まれない', async () => {
  const { storage } = makeStorage();
  const data = loadFixture();
  await importCosense(storage, data, { projectName: 'sandbox', now: 1760000000 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'cosense_互換');
  assert.ok(page);
  await storage.commit({
    projectId: project.id,
    pageId: page.id,
    commitId: 'del1',
    baseVersion: page.version,
    ops: page.lines.map((l) => ({ type: 'delete' as const, id: l.id })),
    actorId: 'u1',
    now: 1760000500,
  });
  const out = await exportCosense(storage, 'sandbox', 'full', 1760001000);
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages.find((p) => p.title === 'Cosense 互換'), undefined);
  await storage.close();
});

void test('存在しないプロジェクトのエクスポートは拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(exportCosense(storage, 'nope', 'full', 1), /unknown project/);
  await storage.close();
});

void test('行を持たないが commits に残るユーザーも export の users に含まれる', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const project = await storage.ensureProject('proj', now);
  await storage.upsertActor({ id: 'U1', name: 'u1', displayName: 'U1' }, now);
  await storage.upsertActor({ id: 'U2', name: 'u2', displayName: 'U2' }, now);
  const pageId = ulid(now * 1000);
  const lineId = ulid(now * 1000);
  await storage.commit({
    projectId: project.id,
    pageId,
    commitId: ulid(now * 1000),
    baseVersion: 0,
    ops: [{ type: 'insert', id: lineId, after: '_head', text: 'T' }],
    actorId: 'U1',
    now,
  });
  await storage.commit({
    projectId: project.id,
    pageId,
    commitId: ulid(now * 1000),
    baseVersion: 1,
    ops: [{ type: 'update', id: lineId, text: 'T2' }],
    actorId: 'U2',
    now,
  });
  const exp = await exportCosense(storage, 'proj', 'full', now);
  const names = (exp.users ?? []).map((u) => u.name).toSorted();
  assert.deepEqual(names, ['u1', 'u2']);
  await storage.close();
});
