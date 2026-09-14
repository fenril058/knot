import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import { parseSearchQuery } from '../src/core/searchQuery.ts';
import { D1Storage, type D1Binding } from '../src/storage/d1.ts';
import { UnsupportedStorageOperationError } from '../src/storage/types.ts';

const args = process.argv.slice(2);
let remote = false;
let configPath = 'wrangler.jsonc';
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (argument === '--remote') {
    remote = true;
  } else if (argument === '--config') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--config requires a path');
    configPath = value;
    index += 1;
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}

process.env.KNOT_ACCESS_CONFIG ??= '{}';
const platform = await getPlatformProxy<{ DB: D1Binding }>({ configPath, remoteBindings: remote });
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const accountId = `smoke-account-${suffix}`;
const actorId = `smoke-actor-${suffix}`;
const pageId = `smoke-page-${suffix}`;
const accountName = `smoke-${suffix}`;

try {
  const migrationRows = await platform.env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const appliedMigrations = new Set(migrationRows.results.map((row) => row.name));
  assert(appliedMigrations.has('0001_identity_projects.sql'));
  assert(appliedMigrations.has('0002_page_reads.sql'));
  const storage = new D1Storage(platform.env.DB);
  const account = await storage.addAccessAccount({
    id: accountId,
    actor: { id: actorId, name: accountName, displayName: 'D1 Smoke' },
    name: accountName,
    email: `${accountName}@example.com`,
  }, Math.floor(Date.now() / 1000));
  assert.notEqual(account.accountId, account.actorId);
  const created = await storage.createProject(accountName, Math.floor(Date.now() / 1000));
  assert.equal(created.kind, 'created');
  await platform.env.DB.batch([
    platform.env.DB.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, NULL, 1, 1)')
      .bind(pageId, created.project.id, 'D1 Smoke', 'd1_smoke'),
    platform.env.DB.prepare(
      'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 0, ?, 1, 1, 1, ?)',
    ).bind(`${pageId}-title`, pageId, 'D1 Smoke', actorId),
    platform.env.DB.prepare(
      'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 1, ?, 1, 1, 1, ?)',
    ).bind(`${pageId}-body`, pageId, 'remote 日本語 search smoke', actorId),
    platform.env.DB.prepare(
      `INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash)
       VALUES (?, ?, 0, 1, ?, 1, '[]', 'smoke')`,
    ).bind(`smoke-commit-${suffix}`, pageId, actorId),
  ]);
  await storage.reindex(created.project.id);
  assert.equal((await storage.getPageById(pageId))?.lines[1]?.text, 'remote 日本語 search smoke');
  assert.equal((await storage.search(created.project.id, parseSearchQuery('日本語 search')))[0]?.pageId, pageId);
  await storage.recordVisit(accountId, pageId, 2, 1);
  assert.deepEqual(await storage.getVisit(accountId, pageId), { visited: 2, lastSeenVersion: 1 });
  await assert.rejects(
    storage.commit({
      projectId: created.project.id,
      pageId,
      commitId: `unsupported-${suffix}`,
      baseVersion: 1,
      ops: [],
      actorId,
      now: 2,
    }),
    UnsupportedStorageOperationError,
  );
  console.log(JSON.stringify({ target: remote ? 'remote' : 'local', migration: 'ok', crud: 'ok', search: 'ok' }));
} finally {
  await platform.env.DB.batch([
    platform.env.DB.prepare('DELETE FROM page_visits WHERE account_id = ?').bind(accountId),
    platform.env.DB.prepare('DELETE FROM page_search WHERE page_id = ?').bind(pageId),
    platform.env.DB.prepare('DELETE FROM links WHERE source_page_id = ?').bind(pageId),
    platform.env.DB.prepare('DELETE FROM commits WHERE page_id = ?').bind(pageId),
    platform.env.DB.prepare('DELETE FROM lines WHERE page_id = ?').bind(pageId),
    platform.env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId),
    platform.env.DB.prepare('DELETE FROM projects WHERE name = ?').bind(accountName),
    platform.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
    platform.env.DB.prepare('DELETE FROM actors WHERE id = ?').bind(actorId),
  ]);
  await platform.dispose();
}
