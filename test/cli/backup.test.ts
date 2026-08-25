import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup } from '../../src/cli/backup.ts';
import { runImport, runInit } from '../../src/cli/commands.ts';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/password.ts';

const fixture = fileURLToPath(new URL('../fixtures/cosense-export.json', import.meta.url));
const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'knot-backup-test-'));
}

async function populatedData(root: string): Promise<{ dataDir: string; attachmentId: string }> {
  const dataDir = join(root, 'data');
  await runInit(dataDir);
  await runImport(dataDir, 'sandbox', fixture, 'skip');
  const attachmentId = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
  const contents = 'restorable attachment';
  writeFileSync(join(dataDir, 'files', attachmentId), contents);
  const db = openDatabase(join(dataDir, 'knot.db'));
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const project = db.prepare('SELECT id FROM projects WHERE name = ?').get('sandbox') as { id: string };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const actor = db.prepare('SELECT id FROM actors ORDER BY id LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO attachments (id, project_id, filename, content_type, size, sha256, actor_id, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(attachmentId, project.id, 'note.txt', 'text/plain', contents.length, 'test-sha256', actor.id, 1_751_000_000);
  } finally {
    db.close();
  }
  return { dataDir, attachmentId };
}

void test('backup からページと添付を復元して配信できる', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataDir, attachmentId } = await populatedData(root);
  const outDir = join(root, 'backup');

  assert.equal(await runBackup(dataDir, outDir), `backed up to ${outDir} (1 attachments verified)`);

  const storage = new SqliteStorage(openDatabase(join(outDir, 'knot.db')));
  t.after(() => storage.close());
  await storage.addAccount(
    {
      id: '01BACKUPLOGINACCOUNT000000',
      actor: { id: '01BACKUPLOGINACTOR00000000', name: 'backup-user', displayName: 'Backup User' },
      name: 'backup-user', passwordHash: hashPassword('pw12345678'), isAdmin: true,
    },
    1_751_000_001,
  );
  const app = createApp({ storage, config: { ...defaultConfig(outDir), secureCookie: false } });
  const login = await app.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Knot-Client': 'test' },
    body: JSON.stringify({ name: 'backup-user', password: 'pw12345678' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

  const page = await app.request('/api/pages/sandbox/knot%20%E8%A8%AD%E8%A8%88%E3%83%A1%E3%83%A2', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const file = await app.request(`/files/${attachmentId}`, { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'restorable attachment');
});

void test('添付実体が欠けると部分出力を消し、同じ引数で再実行できる', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataDir, attachmentId } = await populatedData(root);
  const outDir = join(root, 'backup');
  const sourceFile = join(dataDir, 'files', attachmentId);
  rmSync(sourceFile);

  await assert.rejects(runBackup(dataDir, outDir), new RegExp(attachmentId));
  assert.equal(existsSync(outDir), false);
  assert.deepEqual(readdirSync(root).filter((name) => name !== basename(dataDir)), []);

  writeFileSync(sourceFile, 'restorable attachment');
  assert.match(await runBackup(dataDir, outDir), /1 attachments verified/);
});

void test('既存 outDir と同一・相互包含パスを拒否する', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'container', 'data');
  await runInit(dataDir);
  const existing = join(root, 'existing');
  mkdirSync(existing);

  await assert.rejects(runBackup(dataDir, existing));
  await assert.rejects(runBackup(dataDir, dataDir));
  await assert.rejects(runBackup(dataDir, join(dataDir, 'files', 'bk')));
  await assert.rejects(runBackup(dataDir, dirname(dataDir)));
});

void test('symlink 経由の包含パスも拒否する', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await runInit(dataDir);
  const link = join(root, 'data-link');
  symlinkSync(dataDir, link, 'dir');

  await assert.rejects(runBackup(dataDir, join(link, 'files', 'bk')));
});

void test('symlink と .. を含む outDir は字句的に正規化した dataDir 外へ作る', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await runInit(dataDir);
  const link = join(root, 'link');
  symlinkSync(join(dataDir, 'files'), link, 'dir');
  const outDir = `${link}/../bk`;

  assert.equal(await runBackup(dataDir, outDir), `backed up to ${join(root, 'bk')} (0 attachments verified)`);
  assert.equal(existsSync(join(root, 'bk', 'knot.db')), true);
  assert.equal(existsSync(join(dataDir, 'bk')), false);
});

void test('symlink 添付を実体としてコピーする', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataDir, attachmentId } = await populatedData(root);
  const sourceFile = join(dataDir, 'files', attachmentId);
  const targetFile = join(root, 'attachment-target');
  writeFileSync(targetFile, 'restorable attachment');
  rmSync(sourceFile);
  symlinkSync(targetFile, sourceFile);
  const outDir = join(root, 'backup');

  await runBackup(dataDir, outDir);

  assert.equal(readFileSync(join(outDir, 'files', attachmentId), 'utf8'), 'restorable attachment');
  assert.equal(lstatSync(join(outDir, 'files', attachmentId)).isSymbolicLink(), false);
});

void test('outDir の dangling symlink も既存パスとして拒否する', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await runInit(dataDir);
  const outDir = join(root, 'backup');
  symlinkSync(join(root, 'missing-target'), outDir, 'dir');

  await assert.rejects(runBackup(dataDir, outDir), /already exists/);
});

void test('backup は実行後の元 DB の変更を反映しないスナップショットである', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dataDir } = await populatedData(root);
  const outDir = join(root, 'backup');
  await runBackup(dataDir, outDir);

  const source = openDatabase(join(dataDir, 'knot.db'));
  source.prepare('UPDATE projects SET display_name = ? WHERE name = ?').run('Changed', 'sandbox');
  source.close();
  const snapshot = openDatabase(join(outDir, 'knot.db'));
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = snapshot.prepare('SELECT display_name FROM projects WHERE name = ?').get('sandbox') as { display_name: string };
    assert.equal(row.display_name, 'Sandbox');
  } finally {
    snapshot.close();
  }
});

void test('knot backup --data --out を CLI から実行できる', async (t) => {
  const root = tempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const outDir = join(root, 'backup');
  await runInit(dataDir);

  const output = execFileSync(process.execPath, [mainPath, 'backup', '--data', dataDir, '--out', outDir], {
    encoding: 'utf8',
  });
  assert.equal(output.trim(), `backed up to ${outDir} (0 attachments verified)`);
});
