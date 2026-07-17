import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/storage/db.ts';

test('マイグレーションで全テーブルが作られ user_version が進む', () => {
  const db = openDatabase(':memory:');
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
  const expected = [
    'projects', 'users', 'pages', 'lines', 'commits', 'title_history',
    'page_visits', 'links', 'attachments', 'sessions', 'pages_fts', 'api_tokens',
  ];
  for (const t of expected) assert.ok(names.includes(t), `${t} がない`);
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 4);
  db.close();
});

test('再オープンしても適用済みマイグレーションを二重適用しない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-db-'));
  const path = join(dir, 'knot.db');
  openDatabase(path).close();
  const db = openDatabase(path);
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, 4);
  db.close();
});

test('FTS5 trigram が動く（3 文字はヒット、2 文字は 0 件）', () => {
  const db = openDatabase(':memory:');
  db.prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)').run(
    'p1', 'pr', 'knot 設計書',
  );
  const q = db.prepare('SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?');
  assert.equal(q.all('"設計書"').length, 1);
  assert.equal(q.all('"設計"').length, 0);
  db.close();
});

test('title_lc の一意性は削除済みページに適用されない', () => {
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
