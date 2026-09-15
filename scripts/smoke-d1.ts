import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import { parseSearchQuery } from '../src/core/searchQuery.ts';
import { D1Storage, type D1Binding } from '../src/storage/d1.ts';

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
const platform = await getPlatformProxy<{ DB: D1Binding }>({ configPath, persist: true, remoteBindings: remote });
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const accountId = `smoke-account-${suffix}`;
const actorId = `smoke-actor-${suffix}`;
const pageId = `smoke-page-${suffix}`;
const sourcePageId = `smoke-source-${suffix}`;
const lateSourcePageId = `smoke-late-source-${suffix}`;
const accountName = `smoke-${suffix}`;

try {
  const migrationRows = await platform.env.DB.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const appliedMigrations = new Set(migrationRows.results.map((row) => row.name));
  assert(appliedMigrations.has('0001_identity_projects.sql'));
  assert(appliedMigrations.has('0002_page_reads.sql'));
  assert(appliedMigrations.has('0003_search_fts.sql'));
  assert(appliedMigrations.has('0004_page_mutation_guard.sql'));
  assert(appliedMigrations.has('0005_page_mutation_revisions.sql'));
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
  const initialCommit = {
    projectId: created.project.id,
    pageId,
    commitId: `smoke-initial-${suffix}`,
    baseVersion: 0,
    ops: [
      { type: 'insert' as const, id: `${pageId}-title`, after: '_head', text: 'D1 Smoke' },
      {
        type: 'insert' as const,
        id: `${pageId}-body`,
        after: `${pageId}-title`,
        text: 'remote 日本語 search smoke [Before]',
      },
    ],
    actorId,
    now: 1,
  };
  assert.deepEqual(await storage.commit(initialCommit), { kind: 'applied', version: 1 });
  assert.equal((await storage.getPageById(pageId))?.lines[1]?.text, 'remote 日本語 search smoke [Before]');
  assert.equal((await storage.search(created.project.id, parseSearchQuery('日本語 search')))[0]?.pageId, pageId);
  await storage.recordVisit(accountId, pageId, 2, 1);
  assert.deepEqual(await storage.getVisit(accountId, pageId), { visited: 2, lastSeenVersion: 1 });

  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const barrierDb: D1Binding = {
    prepare: (query) => platform.env.DB.prepare(query),
    async batch(statements) {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await ready;
      return platform.env.DB.batch(statements);
    },
  };
  const makeConcurrentCommit = (commitId: string, text: string) => ({
    projectId: created.project.id,
    pageId,
    commitId,
    baseVersion: 1,
    ops: [{ type: 'update' as const, id: `${pageId}-body`, text }],
    actorId,
    now: 2,
  });
  const left = makeConcurrentCommit(`smoke-left-${suffix}`, 'left wins [Left]');
  const right = makeConcurrentCommit(`smoke-right-${suffix}`, 'right wins [Right]');
  const race = await Promise.all([new D1Storage(barrierDb).commit(left), new D1Storage(barrierDb).commit(right)]);
  assert.equal(race.filter((result) => result.kind === 'applied').length, 1);
  assert.equal(race.filter((result) => result.kind === 'conflict').length, 1);
  const winner = race[0].kind === 'applied' ? left : right;
  assert.deepEqual(await storage.commit(winner), { kind: 'applied', version: 2 });
  assert.equal(
    (await platform.env.DB.prepare('SELECT COUNT(*) AS count FROM commits WHERE page_id = ?')
      .bind(pageId).first<{ count: number }>())?.count,
    2,
  );

  await storage.commit({
    projectId: created.project.id,
    pageId: sourcePageId,
    commitId: `smoke-source-commit-${suffix}`,
    baseVersion: 0,
    ops: [
      { type: 'insert', id: `${sourcePageId}-title`, after: '_head', text: 'Smoke Source' },
      { type: 'insert', id: `${sourcePageId}-body`, after: `${sourcePageId}-title`, text: 'see [D1 Smoke]' },
    ],
    actorId,
    now: 3,
  });
  let backlinkSnapshotRead = false;
  const overlappingRenameDb: D1Binding = {
    prepare(query) {
      const statement = platform.env.DB.prepare(query);
      if (!query.includes('SELECT source_page_id FROM links')) return statement;
      const wrap = (current: typeof statement): typeof statement => ({
        bind(...values) { return wrap(current.bind(...values)); },
        first<T>() { return current.first<T>(); },
        async all<T>() {
          const rows = await current.all<T>();
          if (!backlinkSnapshotRead) {
            backlinkSnapshotRead = true;
            await storage.commit({
              projectId: created.project.id,
              pageId: lateSourcePageId,
              commitId: `smoke-late-source-commit-${suffix}`,
              baseVersion: 0,
              ops: [
                { type: 'insert', id: `${lateSourcePageId}-title`, after: '_head', text: 'Late Smoke Source' },
                {
                  type: 'insert',
                  id: `${lateSourcePageId}-body`,
                  after: `${lateSourcePageId}-title`,
                  text: 'late [D1 Smoke]',
                },
              ],
              actorId,
              now: 4,
            });
          }
          return rows;
        },
        run<T>() { return current.run<T>(); },
      });
      return wrap(statement);
    },
    batch: (statements) => platform.env.DB.batch(statements),
  };
  const renamed = await new D1Storage(overlappingRenameDb).renamePage({
    projectId: created.project.id,
    pageId,
    baseVersion: 2,
    newTitle: 'D1 Renamed',
    rewriteLinks: true,
    actorId,
    now: 5,
  });
  assert.equal(renamed.kind, 'applied');
  assert.equal((await storage.getPageById(sourcePageId))?.lines[1]?.text, 'see [D1 Renamed]');
  assert.equal((await storage.getPageById(lateSourcePageId))?.lines[1]?.text, 'late [D1 Renamed]');
  assert.equal((await storage.deletePage({
    projectId: created.project.id, pageId, baseVersion: 2, actorId, now: 6,
  })).kind, 'conflict');
  assert.deepEqual(await storage.deletePage({
    projectId: created.project.id, pageId, baseVersion: 3, actorId, now: 7,
  }), { kind: 'applied', version: 4 });
  assert.equal((await storage.getPageById(pageId))?.deleted, true);
  assert.equal((await storage.search(created.project.id, parseSearchQuery('wins'))).length, 0);
  console.log(JSON.stringify({
    target: remote ? 'remote' : 'local',
    migration: 'ok',
    crud: 'ok',
    search: 'ok',
    mutationRace: 'ok',
    renameRace: 'ok',
  }));
} finally {
  const pageIds = [pageId, sourcePageId, lateSourcePageId];
  await platform.env.DB.batch([
    platform.env.DB.prepare('DELETE FROM page_visits WHERE account_id = ?').bind(accountId),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(id)),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM links WHERE source_page_id = ?').bind(id)),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM commits WHERE page_id = ?').bind(id)),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM title_history WHERE page_id = ?').bind(id)),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM lines WHERE page_id = ?').bind(id)),
    ...pageIds.map((id) => platform.env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id)),
    platform.env.DB.prepare('DELETE FROM projects WHERE name = ?').bind(accountName),
    platform.env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(accountId),
    platform.env.DB.prepare('DELETE FROM actors WHERE id = ?').bind(actorId),
  ]);
  await platform.dispose();
}
