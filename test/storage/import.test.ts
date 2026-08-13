import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';
import { makeStorage } from '../helpers/storage.ts';
import { importCosense, IMPORTER_USER_NAME } from '../../src/storage/import.ts';
import { StorageError } from '../../src/storage/types.ts';
import type { CosenseExport, CosenseLine } from '../../src/core/cosense.ts';

// CosenseExport で注釈しておくと、lines 要素の書き換えが union 配列への代入エラーにならない
const fixture = (): CosenseExport => ({
  name: 'sandbox',
  displayName: 'Sandbox',
  exported: 1751000000,
  users: [{ id: '5f1a2b3c4d5e6f7a8b9c0d1e', name: 'alice', displayName: 'Alice' }],
  pages: [
    {
      id: '61f0c1d2e3a4b5c6d7e8f901',
      title: 'メタデータ付きページ',
      created: 1750000000,
      updated: 1750001000,
      lines: [
        {
          id: '61f0c1d2e3a4b5c6d7e8f902',
          text: 'メタデータ付きページ',
          userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
          created: 1750000000,
          updated: 1750000000,
        },
        {
          id: '61f0c1d2e3a4b5c6d7e8f903',
          text: '[リンク先] を張る',
          userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
          created: 1750000000,
          updated: 1750001000,
        },
      ],
    },
    {
      title: '簡易形式のページ',
      lines: ['簡易形式のページ', '文字列だけの行'],
    },
  ],
});

void test('メタデータ付きの行が ID・時刻・userId ごと保存される', async () => {
  const { storage } = makeStorage();
  const summary = await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  assert.deepEqual(summary, { created: 2, overwritten: 0, skipped: 0, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.id, '61f0c1d2e3a4b5c6d7e8f901');
  assert.equal(page.created, 1750000000);
  assert.equal(page.version, 1);
  assert.deepEqual(
    page.lines.map((l) => ({ id: l.id, created: l.created, updated: l.updated, userId: l.userId })),
    [
      { id: '61f0c1d2e3a4b5c6d7e8f902', created: 1750000000, updated: 1750000000, userId: '5f1a2b3c4d5e6f7a8b9c0d1e' },
      { id: '61f0c1d2e3a4b5c6d7e8f903', created: 1750000000, updated: 1750001000, userId: '5f1a2b3c4d5e6f7a8b9c0d1e' },
    ],
  );
  await storage.close();
});

void test('文字列行はインポート時刻と knot-import ユーザーで埋まる', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, '簡易形式のページ');
  assert.ok(page);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const importer = db.prepare('SELECT id, password_hash FROM users WHERE name = ?').get(IMPORTER_USER_NAME) as {
    id: string; password_hash: string | null;
  };
  assert.equal(importer.password_hash, null);
  for (const line of page.lines) {
    assert.equal(line.created, 1760000000);
    assert.equal(line.userId, importer.id);
    assert.match(line.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  }
  await storage.close();
});

void test('インポートはコミットとして残り、導出データも更新される', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const commit = db
    .prepare('SELECT base_version, version, ops FROM commits WHERE page_id = ?')
    .get('61f0c1d2e3a4b5c6d7e8f901') as { base_version: number; version: number; ops: string };
  assert.equal(commit.base_version, 0);
  assert.equal(commit.version, 1);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const ops = JSON.parse(commit.ops) as { type: string; text?: string }[];
  assert.equal(ops.length, 2);
  assert.equal(ops[0]!.type, 'insert');
  assert.equal(ops[0]!.text, 'メタデータ付きページ');
  const links = (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all('61f0c1d2e3a4b5c6d7e8f901') as {
      target_title_lc: string;
    }[]
  ).map((r) => r.target_title_lc);
  assert.deepEqual(links, ['リンク先']);
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const hits = await storage.search(project.id, parseSearchQuery('リンク先'));
  assert.equal(hits.length, 1);
  await storage.close();
});

void test('再インポートは既定でスキップされ、内容が変わらない', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const summary = await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1770000000 });
  assert.deepEqual(summary, { created: 0, overwritten: 0, skipped: 2, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.version, 1);
  assert.equal(page.lines[0]!.created, 1750000000);
  await storage.close();
});

void test('overwrite は既存ページを新しいコミットとして置き換える', async () => {
  const { db, storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const modified = fixture();
  modified.pages[0]!.lines[1] = {
    id: '61f0c1d2e3a4b5c6d7e8f903',
    text: '書き換えた行',
    userId: '5f1a2b3c4d5e6f7a8b9c0d1e',
    created: 1750000000,
    updated: 1755000000,
  };
  const summary = await importCosense(storage, modified, {
    projectName: 'sandbox', onConflict: 'overwrite', now: 1770000000,
  });
  assert.deepEqual(summary, { created: 0, overwritten: 2, skipped: 0, users: 1 });
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.equal(page.version, 2);
  assert.equal(page.lines[1]!.text, '書き換えた行');
  assert.equal(page.lines[1]!.updated, 1755000000);
  // 上書きはインポート元のページメタデータを保持する（バックアップ復元の round-trip）
  assert.equal(page.created, 1750000000);
  assert.equal(page.updated, 1750001000);
  // 上書きも commits に残る（delete + insert の ops）
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const commits = db
    .prepare('SELECT ops FROM commits WHERE page_id = ? ORDER BY version')
    .all('61f0c1d2e3a4b5c6d7e8f901') as { ops: string }[];
  assert.equal(commits.length, 2);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const secondOps = JSON.parse(commits[1]!.ops) as { type: string }[];
  assert.equal(secondOps[0]!.type, 'delete');
  assert.equal(secondOps.at(-1)?.type, 'insert');
  await storage.close();
});

void test('page id が衝突したら新しい ULID で取り込む（別プロジェクトへの同一エクスポート）', async () => {
  const { storage } = makeStorage();
  await importCosense(storage, fixture(), { projectName: 'sandbox', now: 1760000000 });
  const summary = await importCosense(storage, fixture(), { projectName: 'mirror', now: 1770000000 });
  assert.deepEqual(summary, { created: 2, overwritten: 0, skipped: 0, users: 1 });
  const mirror = await storage.getProject('mirror');
  assert.ok(mirror);
  const page = await storage.getPageByTitle(mirror.id, 'メタデータ付きページ');
  assert.ok(page);
  assert.notEqual(page.id, '61f0c1d2e3a4b5c6d7e8f901');
  assert.match(page.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  await storage.close();
});

void test('不正な JSON と重複行 ID は拒否する', async () => {
  const { storage } = makeStorage();
  await assert.rejects(importCosense(storage, { nope: true }, { projectName: 'sandbox' }), /pages/);
  const dup = fixture();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const line1 = dup.pages[0]!.lines[1] as Exclude<CosenseLine, string>;
  dup.pages[0]!.lines[1] = { ...line1, id: '61f0c1d2e3a4b5c6d7e8f902' };
  await assert.rejects(importCosense(storage, dup, { projectName: 'sandbox' }), StorageError);
  // 失敗したページは作られていない
  const project = await storage.getProject('sandbox');
  assert.ok(project);
  assert.equal(await storage.getPageByTitle(project.id, 'メタデータ付きページ'), null);
  await storage.close();
});

void test('同名別 ID のユーザーは既存 ID に統合され、行の userId も再マップされる', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  await storage.upsertDisplayUser({ id: 'A1', name: 'alice', displayName: 'Alice' }, now);
  const data = {
    name: 'proj',
    displayName: 'Proj',
    exported: now,
    users: [{ id: 'A2', name: 'alice', displayName: 'Alice' }],
    pages: [{
      id: '0'.repeat(24),
      title: 'P',
      created: now,
      updated: now,
      lines: [{ id: '1'.repeat(24), text: 'P', userId: 'A2', created: now, updated: now }],
    }],
  };
  await importCosense(storage, data, { projectName: 'proj', now });
  const project = await storage.getProject('proj');
  assert.ok(project);
  const page = await storage.getPageByTitle(project.id, 'p');
  assert.ok(page);
  assert.equal(page.lines[0]!.userId, 'A1');
  await storage.close();
});

void test('エクスポート元の displayName がプロジェクトに反映される', async () => {
  const { storage } = makeStorage();
  const now = 1700000000;
  const data = {
    name: 'proj',
    displayName: '素敵なプロジェクト',
    exported: now,
    pages: [{ title: 'P', lines: ['P'] }],
  };
  await importCosense(storage, data, { projectName: 'proj', now });
  const project = await storage.getProject('proj');
  assert.ok(project);
  assert.equal(project.displayName, '素敵なプロジェクト');
  await storage.close();
});
