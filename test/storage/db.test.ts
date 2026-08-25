import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';

const migrationsDir = new URL('../../src/storage/migrations/', import.meta.url);

function createDatabaseAtVersion(path: string, version: number): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  for (let current = 1; current <= version; current++) {
    const names = [
      '0001_init.sql',
      '0002_links_target_title.sql',
      '0003_attachments_unique.sql',
      '0004_api_tokens.sql',
      '0005_attachment_claims.sql',
      '0006_page_visit_views.sql',
    ];
    const name = names[current - 1];
    assert.ok(name);
    db.exec(readFileSync(new URL(name, migrationsDir), 'utf8'));
    db.exec(`PRAGMA user_version = ${current}`);
  }
  return db;
}

void test('マイグレーションで全テーブルが作られ user_version が進む', () => {
  const db = openDatabase(':memory:');
  const names = (
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const expected = [
    'projects', 'actors', 'accounts', 'pages', 'lines', 'commits', 'title_history',
    'page_visits', 'links', 'attachments', 'sessions', 'pages_fts', 'api_tokens', 'attachment_claims',
  ];
  for (const t of expected) assert.ok(names.includes(t), `${t} がない`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 7);
  db.close();
});

void test('再オープンしても適用済みマイグレーションを二重適用しない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-'));
  const path = join(dir, 'knot.db');
  openDatabase(path).close();
  const db = openDatabase(path);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 7);
  db.close();
});

void test('v5 の既存訪問行は v6 で1回の閲覧として移行し、次の訪問を加算する', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-v5-'));
  const path = join(dir, 'knot.db');
  const oldDb = createDatabaseAtVersion(path, 5);
  oldDb.exec(`
    INSERT INTO projects (id, name, display_name, created, updated) VALUES ('pr', 'pr', 'pr', 1, 1);
    INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
      VALUES ('p1', 'pr', 'P', 'p', 1, 0, 0, NULL, 1, 1);
    INSERT INTO page_visits (user_id, page_id, visited, last_seen_version)
      VALUES ('u1', 'p1', 100, 2);
  `);
  oldDb.close();

  const db = openDatabase(path);
  const storage = new SqliteStorage(db);
  assert.deepEqual(await storage.getPageVisitMetrics('p1'), { views: 1, accessed: 100 });
  assert.deepEqual(await storage.getVisit('u1', 'p1'), { visited: 100, lastSeenVersion: 2 });

  await storage.recordVisit('u1', 'p1', 110, 3);
  assert.deepEqual(await storage.getPageVisitMetrics('p1'), { views: 2, accessed: 110 });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(version, 7);
  await storage.close();
});

void test('v6 の認証 user と imported user を Account と Actor に分離して作者・認証参照を維持する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-v6-identity-'));
  const path = join(dir, 'knot.db');
  const oldDb = createDatabaseAtVersion(path, 6);
  oldDb.exec(`
    INSERT INTO projects (id, name, display_name, created, updated)
      VALUES ('project', 'project', 'Project', 1, 2);
    INSERT INTO users (id, name, display_name, email, password_hash, is_admin, created) VALUES
      ('auth-user', 'alice', 'Alice', 'alice@example.test', 'password-hash', 1, 1),
      ('imported-user', 'bob', 'Bob', NULL, NULL, 0, 2);
    INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
      VALUES ('page', 'project', 'Page', 'page', 1, 0, 0, NULL, 1, 2);
    INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id) VALUES
      ('line-1', 'page', 0, 'Page', 1, 1, 1, 'auth-user'),
      ('line-2', 'page', 1, 'body', 1, 2, 1, 'imported-user');
    INSERT INTO commits (id, page_id, base_version, version, user_id, created, ops, ops_hash)
      VALUES ('commit', 'page', 0, 1, 'auth-user', 2, '[]', 'hash');
    INSERT INTO attachments
      (id, project_id, filename, content_type, size, sha256, user_id, created, provisional)
      VALUES ('attachment', 'project', 'a.txt', 'text/plain', 1, 'sha', 'imported-user', 2, 1);
    INSERT INTO attachment_claims (attachment_id, owner) VALUES ('attachment', 'import');
    INSERT INTO sessions (id, user_id, expires, created) VALUES ('session', 'auth-user', 100, 2);
    INSERT INTO api_tokens (id, user_id, label, token_hash, created)
      VALUES ('token', 'auth-user', 'test', 'token-hash', 2);
    INSERT INTO page_visits (user_id, page_id, visited, last_seen_version, views)
      VALUES ('auth-user', 'page', 10, 1, 3);
  `);
  oldDb.close();

  const db = openDatabase(path);
  const one = (sql: string): Record<string, unknown> => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return db.prepare(sql).get() as Record<string, unknown>;
  };
  assert.equal(one('SELECT count(*) AS count FROM actors').count, 2);
  assert.equal(one('SELECT count(*) AS count FROM accounts').count, 1);
  assert.deepEqual({ ...one(
    'SELECT id, actor_id, name, email, password_hash, is_admin FROM accounts',
  ) }, {
    id: 'auth-user', actor_id: 'auth-user', name: 'alice', email: 'alice@example.test',
    password_hash: 'password-hash', is_admin: 1,
  });
  assert.deepEqual(
    db.prepare('SELECT id, name FROM actors ORDER BY id').all().map((row) => ({ ...row })),
    [{ id: 'auth-user', name: 'alice' }, { id: 'imported-user', name: 'bob' }],
  );
  assert.deepEqual(
    db.prepare('SELECT id, actor_id FROM lines ORDER BY ord').all().map((row) => ({ ...row })),
    [{ id: 'line-1', actor_id: 'auth-user' }, { id: 'line-2', actor_id: 'imported-user' }],
  );
  assert.equal(one('SELECT actor_id FROM commits').actor_id, 'auth-user');
  assert.equal(one('SELECT actor_id FROM attachments').actor_id, 'imported-user');
  assert.equal(one('SELECT account_id FROM sessions').account_id, 'auth-user');
  assert.equal(one('SELECT account_id FROM api_tokens').account_id, 'auth-user');
  assert.equal(one('SELECT account_id FROM page_visits').account_id, 'auth-user');
  assert.deepEqual({ ...one('SELECT attachment_id, owner FROM attachment_claims') }, {
    attachment_id: 'attachment', owner: 'import',
  });
  assert.equal(one(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN "
      + "('lines_page_ord', 'attachments_project_sha', 'attachment_claims_owner', 'page_visits_page_id')",
  ).count, 4);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(one('PRAGMA user_version').user_version, 7);
  assert.equal(one(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).count, 0);
  db.close();
});

void test('v6 の不正な認証参照で migration が失敗した場合は schema と user_version をロールバックする', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-v6-rollback-'));
  const path = join(dir, 'knot.db');
  const oldDb = createDatabaseAtVersion(path, 6);
  oldDb.exec(`
    INSERT INTO users (id, name, display_name, password_hash, is_admin, created)
      VALUES ('imported-user', 'bob', 'Bob', NULL, 0, 1);
    INSERT INTO sessions (id, user_id, expires, created)
      VALUES ('invalid-session', 'imported-user', 100, 1);
  `);
  oldDb.close();

  assert.throws(() => openDatabase(path), /FOREIGN KEY constraint failed/);

  const db = new DatabaseSync(path);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(version, 6);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() !== undefined, true);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actors'").get(), undefined);
  db.close();
});

void test('FTS5 trigram が動く（3 文字はヒット、2 文字は 0 件）', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)').run(
    'p1', 'pr', 'knot 設計書',
  );
  const q = db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?');
  assert.equal(q.all('"設計書"').length, 1);
  assert.equal(q.all('"設計"').length, 0);
  db.close();
});

void test('title_lc の一意性は削除済みページに適用されない', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO projects (id, name, display_name, created, updated) VALUES ('p', 'p', 'p', 0, 0)").run();
  const ins = db.prepare(
    `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
     VALUES (?, 'p', 'T', 't', 1, 0, ?, NULL, 0, 0)`,
  );
  ins.run('a', 1);
  ins.run('b', 0);
  assert.throws(() => ins.run('c', 0), /UNIQUE/);
  db.close();
});
