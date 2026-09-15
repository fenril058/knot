import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTestHarness } from 'wrangler';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';
import { D1Storage, type D1Binding } from '../../src/storage/d1.ts';
import {
  BadCommitError,
  StorageError,
  type RelatedPages,
  type Storage,
} from '../../src/storage/types.ts';
import { createCloudflareApp } from '../../src/worker/app.ts';
import { makeStorage } from '../helpers/storage.ts';
import { assertRenameConflictContract } from '../helpers/renameContract.ts';

const access = {
  issuer: 'https://knot-test.cloudflareaccess.com',
  audience: 'test-audience',
  email: 'owner@example.com',
  accountId: 'account-1',
  actorId: 'actor-2',
};
const accessKeys = await generateKeyPair('RS256');
const accessKey: JWTVerifyGetKey = async () => accessKeys.publicKey;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: access.email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(access.issuer)
    .setAudience(access.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(accessKeys.privateKey);
}

async function testDatabase(): Promise<{
  server: ReturnType<typeof createTestHarness>;
  db: D1Binding;
}> {
  const server = createTestHarness({ workers: [{ configPath: './wrangler.jsonc' }] });
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  const env = await worker.getEnv();
  // The harness returns generated binding types at runtime, while this test keeps the adapter's narrow D1 port.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { server, db: env.DB as D1Binding };
}

async function seedReadFixture(db: D1Binding): Promise<void> {
  const statements = [
    db.prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
      .bind('author-1', 'author', 'Author', 100),
    db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('home', 'project-1', 'Home', 'home', 1, 0, 0, null, 100, 110),
    db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('forward', 'project-1', 'Forward', 'forward', 1, 0, 0, 'https://example.com/image.png', 101, 111),
    db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('back', 'project-1', 'Back', 'back', 1, 0, 0, null, 102, 112),
    db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind('sibling', 'project-1', 'Sibling', 'sibling', 1, 0, 0, null, 103, 113),
  ];
  const pageLines = [
    ['home', 'Home', 100],
    ['home', '日本語の設計 [Forward] [Shared Topic] 100% A_B', 101],
    ['forward', 'Forward', 102],
    ['forward', '検索の設計', 103],
    ['back', 'Back', 104],
    ['back', 'see [Home]', 105],
    ['sibling', 'Sibling', 106],
    ['sibling', 'also [Shared Topic]', 107],
  ] as const;
  for (const [pageId, text, created] of pageLines) {
    statements.push(db.prepare(
      'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(`${pageId}-${created}`, pageId, created % 2, text, created, created, 1, 'author-1'));
  }
  for (const pageId of ['home', 'forward', 'back', 'sibling']) {
    statements.push(db.prepare(
      'INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash) VALUES (?, ?, 0, 1, ?, 100, ?, ?)',
    ).bind(`commit-${pageId}`, pageId, 'author-1', '[]', `hash-${pageId}`));
  }
  statements.push(
    db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').bind('project-1', 'home', 'forward', 'Forward'),
    db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').bind('project-1', 'home', 'shared_topic', 'Shared Topic'),
    db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').bind('project-1', 'back', 'home', 'Home'),
    db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').bind('project-1', 'sibling', 'shared_topic', 'Shared Topic'),
  );
  await db.batch(statements);
}

function seedSqliteReadFixture(db: DatabaseSync): void {
  db.prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
    .run('author-1', 'author', 'Author', 100);
  const pages = [
    ['home', 'Home', 'home', null, 100, 110],
    ['forward', 'Forward', 'forward', 'https://example.com/image.png', 101, 111],
    ['back', 'Back', 'back', null, 102, 112],
    ['sibling', 'Sibling', 'sibling', null, 103, 113],
  ] as const;
  for (const [id, title, titleLc, image, created, updated] of pages) {
    db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)')
      .run(id, 'project-1', title, titleLc, image, created, updated);
  }
  const lines = [
    ['home', 'Home', 100],
    ['home', '日本語の設計 [Forward] [Shared Topic] 100% A_B', 101],
    ['forward', 'Forward', 102],
    ['forward', '検索の設計', 103],
    ['back', 'Back', 104],
    ['back', 'see [Home]', 105],
    ['sibling', 'Sibling', 106],
    ['sibling', 'also [Shared Topic]', 107],
  ] as const;
  for (const [pageId, text, created] of lines) {
    db.prepare(
      'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(`${pageId}-${created}`, pageId, created % 2, text, created, created, 'author-1');
  }
  for (const pageId of ['home', 'forward', 'back', 'sibling']) {
    db.prepare(
      'INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash) VALUES (?, ?, 0, 1, ?, 100, ?, ?)',
    ).run(`commit-${pageId}`, pageId, 'author-1', '[]', `hash-${pageId}`);
  }
  for (const link of [
    ['project-1', 'home', 'forward', 'Forward'],
    ['project-1', 'home', 'shared_topic', 'Shared Topic'],
    ['project-1', 'back', 'home', 'Home'],
    ['project-1', 'sibling', 'shared_topic', 'Shared Topic'],
  ] as const) {
    db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').run(...link);
  }
}

function normalizeRelatedPageLinks(pages: RelatedPages['links1hop']): RelatedPages['links1hop'] {
  return pages.map((page) => ({
    ...page,
    linksLc: page.linksLc.toSorted(),
  }));
}

function normalizedRelated(related: RelatedPages): RelatedPages {
  return {
    ...related,
    links1hop: normalizeRelatedPageLinks(related.links1hop),
    links2hop: normalizeRelatedPageLinks(related.links2hop),
  };
}

async function readContract(storage: Storage) {
  const searches = await Promise.all(['設計', '設計 検索', '設計 -検索', 'shared', '"Home\n日本語"'].map(async (query) => ({
    query,
    hits: await storage.search('project-1', parseSearchQuery(query)),
  })));
  const summaries = await Promise.all((['updated', 'created', 'linked', 'title', 'views', 'accessed'] as const).map(async (sort) => ({
    sort,
    result: await storage.listPageSummaries('project-1', { skip: 0, limit: 100, sort }),
  })));
  return {
    page: await storage.getPageById('home'),
    pages: await storage.listPages('project-1'),
    related: normalizedRelated(await storage.getRelatedPages('project-1', 'home', 'home')),
    summaries,
    visit: await storage.getVisit('account-1', 'home'),
    searches,
  };
}

type QueryMeasurements = {
  queries: number;
  batchStatements: number;
  largeBoundStrings: number;
  maxParameters: number;
  maxStatementBytes: number;
  maxBoundStringBytes: number;
};

function countQueries(db: D1Binding): {
  binding: D1Binding;
  count: () => number;
  measurements: () => QueryMeasurements;
  reset: () => void;
} {
  type Statement = ReturnType<D1Binding['prepare']>;
  const rawStatements = new WeakMap<Statement, Statement>();
  let count = 0;
  let batchStatements = 0;
  let largeBoundStrings = 0;
  let maxParameters = 0;
  let maxStatementBytes = 0;
  let maxBoundStringBytes = 0;
  return {
    binding: {
      prepare(query) {
        count += 1;
        maxParameters = Math.max(maxParameters, query.match(/\?/gu)?.length ?? 0);
        maxStatementBytes = Math.max(maxStatementBytes, Buffer.byteLength(query));
        const statement = db.prepare(query);
        const measuredStatement: Statement = {
          bind(...values) {
            for (const value of values) {
              if (typeof value === 'string') {
                maxBoundStringBytes = Math.max(maxBoundStringBytes, Buffer.byteLength(value));
                if (Buffer.byteLength(value) > 1_000) largeBoundStrings += 1;
              }
            }
            return statement.bind(...values);
          },
          first: <T>() => statement.first<T>(),
          all: <T>() => statement.all<T>(),
          run: <T>() => statement.run<T>(),
        };
        rawStatements.set(measuredStatement, statement);
        return measuredStatement;
      },
      batch(statements) {
        batchStatements += statements.length;
        return db.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
      },
    },
    count: () => count,
    measurements: () => ({
      queries: count,
      batchStatements,
      largeBoundStrings,
      maxParameters,
      maxStatementBytes,
      maxBoundStringBytes,
    }),
    reset: () => {
      count = 0;
      batchStatements = 0;
      largeBoundStrings = 0;
      maxParameters = 0;
      maxStatementBytes = 0;
      maxBoundStringBytes = 0;
    },
  };
}

async function seedManyLinkedPages(db: D1Binding, count: number): Promise<void> {
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    const id = `target-${index}`;
    const title = `Target ${index}`;
    statements.push(
      db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)')
        .bind(id, 'project-1', title, `target_${index}`, 200 + index, 200 + index),
      db.prepare(
        'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 0, ?, 1, 1, 1, ?)',
      ).bind(`${id}-title`, id, `${title} shared`, 'author-1'),
      db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)')
        .bind('project-1', 'home', `target_${index}`, title),
    );
  }
  await db.batch(statements);
}

async function sqliteSearchOrder(query: string): Promise<string[]> {
  const { db, storage } = makeStorage();
  try {
    await storage.upsertActor({ id: 'author-1', name: 'author', displayName: 'Author' }, 100);
    db.prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', 'project', 'project', 100, 100);
    const pages = [
      ['alpha', 'Alpha', 'alpha', 100, 300],
      ['bravo', 'Bravo', 'bravo', 101, 200],
      ['charlie', 'Charlie', 'charlie', 102, 100],
    ] as const;
    for (const [id, title, titleLc, created, updated] of pages) {
      db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)')
        .run(id, 'project-1', title, titleLc, created, updated);
    }
    const lines = [
      ['alpha-title', 'alpha', 0, 'Alpha'],
      ['alpha-body', 'alpha', 1, 'shared'],
      ['bravo-title', 'bravo', 0, 'Bravo'],
      ['bravo-body', 'bravo', 1, 'shared shared shared'],
      ['charlie-title', 'charlie', 0, 'Charlie'],
      ['charlie-body', 'charlie', 1, 'shared'],
    ] as const;
    for (const [id, pageId, ord, text] of lines) {
      db.prepare(
        'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, ?, ?, 1, 1, 1, ?)',
      ).run(id, pageId, ord, text, 'author-1');
    }
    await storage.reindex('project-1');
    return (await storage.search('project-1', parseSearchQuery(query))).map((hit) => hit.pageId);
  } finally {
    await storage.close();
  }
}

void test('D1 migrations are forward-only, repeatable, and upgrade a partially migrated database', async () => {
  const { server, db } = await testDatabase();
  try {
    const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    assert.deepEqual(applied.results.map((row) => row.name), [
      '0001_identity_projects.sql',
      '0002_page_reads.sql',
      '0003_search_fts.sql',
      '0004_page_mutation_guard.sql',
      '0005_page_mutation_revisions.sql',
      '0006_page_mutation_payload.sql',
    ]);
    await server.getWorker().applyD1Migrations('DB');
    const reapplied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    assert.deepEqual(reapplied.results, applied.results);
  } finally {
    await server.close();
  }

  const partialServer = createTestHarness({ workers: [{ configPath: './wrangler.jsonc' }] });
  try {
    await partialServer.listen();
    const worker = partialServer.getWorker();
    const env = await worker.getEnv();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const partialDb = env.DB as D1Binding;
    const applySql = async (sql: string): Promise<void> => {
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await partialDb.prepare(statement).run();
      }
    };
    await applySql(await readFile('src/storage/migrations/d1/0001_identity_projects.sql', 'utf8'));
    await applySql(await readFile('src/storage/migrations/d1/0002_page_reads.sql', 'utf8'));
    await applySql(
      `CREATE TABLE d1_migrations(
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
       );
       INSERT INTO d1_migrations (name) VALUES ('0001_identity_projects.sql');
       INSERT INTO d1_migrations (name) VALUES ('0002_page_reads.sql');`,
    );
    await worker.applyD1Migrations('DB');
    const upgraded = await partialDb.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    assert.deepEqual(upgraded.results.map((row) => row.name), [
      '0001_identity_projects.sql',
      '0002_page_reads.sql',
      '0003_search_fts.sql',
      '0004_page_mutation_guard.sql',
      '0005_page_mutation_revisions.sql',
      '0006_page_mutation_payload.sql',
    ]);
    assert.notEqual(await partialDb.prepare("SELECT name FROM sqlite_master WHERE name = 'pages'").first(), null);
  } finally {
    await partialServer.close();
  }
});

void test('D1 page commit creates a page and preserves derived data', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
      .bind('project-1', 'wiki', 'wiki', 100, 100).run();
    const storage = new D1Storage(db);
    const result = await storage.commit({
      projectId: 'project-1',
      pageId: 'page-1',
      commitId: 'commit-1',
      baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-1', after: '_head', text: 'Home' },
        { type: 'insert', id: 'line-2', after: 'line-1', text: 'see [Other]' },
      ],
      actorId: 'actor-1',
      now: 200,
    });
    assert.deepEqual(result, { kind: 'applied', version: 1 });
    assert.deepEqual((await storage.getPageById('page-1'))?.lines.map((line) => line.text), [
      'Home',
      'see [Other]',
    ]);
    assert.deepEqual((await storage.search('project-1', parseSearchQuery('Home'))).map((hit) => hit.pageId), [
      'page-1',
    ]);
    assert.deepEqual(await storage.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-2', baseVersion: 1,
      ops: [{ type: 'update', id: 'line-1', text: 'Renamed' }], actorId: 'actor-1', now: 300,
    }), { kind: 'applied', version: 2 });
    assert.equal(await storage.getPageByTitle('project-1', 'home'), null);
    assert.equal((await storage.getPageByTitle('project-1', 'renamed'))?.version, 2);
    const history = await db.prepare(
      'SELECT old_title, old_title_lc, started, ended FROM title_history WHERE page_id = ?',
    ).bind('page-1').first<{ old_title: string; old_title_lc: string; started: number; ended: number }>();
    assert.deepEqual(history, { old_title: 'Home', old_title_lc: 'home', started: 200, ended: 300 });
  } finally {
    await server.close();
  }
});

async function seedMutationProject(db: D1Binding): Promise<D1Storage> {
  await db.prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
    .bind('project-1', 'wiki', 'wiki', 100, 100).run();
  return new D1Storage(db);
}

async function tableCount(db: D1Binding, table: string, where = '', ...values: unknown[]): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).bind(...values).first<{ count: number }>();
  return row?.count ?? 0;
}

function concurrentMutationInput(commitId: string, title: string) {
  return {
    projectId: 'project-1',
    pageId: 'page-1',
    commitId,
    baseVersion: 1,
    ops: [{ type: 'update' as const, id: 'line-body', text: `${title} [${title} Link]` }],
    actorId: 'actor-1',
    now: 200,
  };
}

void test('D1 commit retry is idempotent and rejects commitId reuse', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    const input = {
      projectId: 'project-1',
      pageId: 'page-1',
      commitId: 'commit-1',
      baseVersion: 0,
      ops: [{ type: 'insert' as const, id: 'line-1', after: '_head', text: 'Home' }],
      actorId: 'actor-1',
      now: 200,
    };
    assert.deepEqual(await storage.commit(input), { kind: 'applied', version: 1 });
    assert.deepEqual(await storage.commit(input), { kind: 'applied', version: 1 });
    assert.equal(await tableCount(db, 'commits'), 1);
    assert.equal((await storage.getPageById('page-1'))?.version, 1);
    await assert.rejects(
      storage.commit({ ...input, pageId: 'page-2' }),
      BadCommitError,
    );
    assert.equal(await tableCount(db, 'commits'), 1);
    assert.equal(await storage.getPageById('page-2'), null);
  } finally {
    await server.close();
  }
});

void test('D1 commit confirms commitId after the batch response is lost', async () => {
  const { server, db } = await testDatabase();
  try {
    const initial = await seedMutationProject(db);
    await initial.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-initial', baseVersion: 0,
      ops: [{ type: 'insert', id: 'line-title', after: '_head', text: 'Home' }],
      actorId: 'actor-1', now: 100,
    });
    let loseNextBatchResponse = true;
    const responseLossDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      async batch<T = unknown>(statements: Parameters<D1Binding['batch']>[0]) {
        const result = await db.batch<T>(statements);
        if (loseNextBatchResponse) {
          loseNextBatchResponse = false;
          throw new Error('batch response lost');
        }
        return result;
      },
    };

    assert.deepEqual(await new D1Storage(responseLossDb).commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-after-loss', baseVersion: 1,
      ops: [{ type: 'update', id: 'line-title', text: 'Renamed' }], actorId: 'actor-1', now: 200,
    }), { kind: 'applied', version: 2 });
    assert.equal(await tableCount(db, 'commits', 'WHERE page_id = ?', 'page-1'), 2);
    assert.equal((await initial.getPageById('page-1'))?.title, 'Renamed');
  } finally {
    await server.close();
  }
});

void test('D1 concurrent commits from the same snapshot apply at most once', async () => {
  const { server, db } = await testDatabase();
  try {
    const initial = await seedMutationProject(db);
    await initial.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-initial', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-title', after: '_head', text: 'Home' },
        { type: 'insert', id: 'line-body', after: 'line-title', text: 'initial' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let arrivals = 0;
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const barrierDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      async batch(statements) {
        arrivals += 1;
        if (arrivals === 2) release?.();
        await ready;
        return db.batch(statements);
      },
    };
    const left = new D1Storage(barrierDb);
    const right = new D1Storage(barrierDb);
    const results = await Promise.all([
      left.commit(concurrentMutationInput('commit-left', 'Left')),
      right.commit(concurrentMutationInput('commit-right', 'Right')),
    ]);
    assert.equal(results.filter((result) => result.kind === 'applied').length, 1);
    const conflict = results.find((result) => result.kind === 'conflict');
    assert.equal(conflict?.kind, 'conflict');
    if (conflict?.kind === 'conflict') assert.equal(conflict.page.version, 2);
    const page = await left.getPageById('page-1');
    assert.ok(page);
    assert.equal(page.version, 2);
    assert.equal(page.title, 'Home');
    assert.ok(page.lines[1]?.text === 'Left [Left Link]' || page.lines[1]?.text === 'Right [Right Link]');
    const winningTerm = page.lines[1]?.text.startsWith('Left') ? 'Left' : 'Right';
    assert.equal(await tableCount(db, 'commits', 'WHERE page_id = ?', 'page-1'), 2);
    assert.equal(await tableCount(db, 'links', 'WHERE source_page_id = ?', 'page-1'), 1);
    assert.deepEqual(
      (await left.search('project-1', parseSearchQuery(winningTerm))).map((hit) => hit.pageId),
      ['page-1'],
    );
  } finally {
    await server.close();
  }
});

void test('D1 concurrent commits to independent pages all apply', async () => {
  const { server, db } = await testDatabase();
  try {
    const initial = await seedMutationProject(db);
    for (let index = 0; index < 5; index += 1) {
      await initial.commit({
        projectId: 'project-1', pageId: `page-${index}`, commitId: `initial-${index}`, baseVersion: 0,
        ops: [
          { type: 'insert', id: `title-${index}`, after: '_head', text: `Page ${index}` },
          { type: 'insert', id: `body-${index}`, after: `title-${index}`, text: 'before' },
        ],
        actorId: 'actor-1', now: 100,
      });
    }
    let arrivals = 0;
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const barrierDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      async batch(statements) {
        arrivals += 1;
        if (arrivals === 5) release?.();
        await ready;
        return db.batch(statements);
      },
    };
    const storage = new D1Storage(barrierDb);
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => storage.commit({
      projectId: 'project-1', pageId: `page-${index}`, commitId: `update-${index}`, baseVersion: 1,
      ops: [{ type: 'update', id: `body-${index}`, text: 'after' }], actorId: 'actor-1', now: 200,
    })));

    assert.equal(results.filter((result) => result.kind === 'applied').length, 5);
    for (let index = 0; index < 5; index += 1) {
      const page = await initial.getPageById(`page-${index}`);
      assert.equal(page?.version, 2);
      assert.equal(page?.lines[1]?.text, 'after');
    }
  } finally {
    await server.close();
  }
});

void test('D1 commit returns the latest version conflict when a read overlaps another commit', async () => {
  const { server, db } = await testDatabase();
  try {
    const initial = await seedMutationProject(db);
    await initial.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-initial', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-title', after: '_head', text: 'Home' },
        { type: 'insert', id: 'line-body', after: 'line-title', text: 'initial' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let intercepted = false;
    const overlappingDb: D1Binding = {
      prepare(query) {
        const statement = db.prepare(query);
        if (!query.includes('AS lines_json FROM pages AS p WHERE p.id = ?')) return statement;
        const wrap = (current: typeof statement): typeof statement => ({
          bind(...values) {
            return wrap(current.bind(...values));
          },
          async first<T>() {
            const row = await current.first<T>();
            if (!intercepted) {
              intercepted = true;
              await initial.commit({
                projectId: 'project-1', pageId: 'page-1', commitId: 'commit-winner', baseVersion: 1,
                ops: [{ type: 'delete', id: 'line-body' }], actorId: 'actor-1', now: 200,
              });
            }
            return row;
          },
          all<T>() {
            return current.all<T>();
          },
          run<T>() {
            return current.run<T>();
          },
        });
        return wrap(statement);
      },
      batch: (statements) => db.batch(statements),
    };

    const result = await new D1Storage(overlappingDb).commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-loser', baseVersion: 1,
      ops: [{ type: 'update', id: 'line-body', text: 'loser' }], actorId: 'actor-1', now: 200,
    });

    assert.equal(result.kind, 'conflict');
    if (result.kind === 'conflict') {
      assert.equal(result.reason, 'version');
      assert.equal(result.page.version, 2);
      assert.deepEqual(result.page.lines.map((line) => line.text), ['Home']);
    }
  } finally {
    await server.close();
  }
});

void test('D1 stale delete preserves the latest page and current delete removes derived data atomically', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-1', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-1', after: '_head', text: 'Home' },
        { type: 'insert', id: 'line-2', after: 'line-1', text: 'latest [Other]' },
      ],
      actorId: 'actor-1', now: 200,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-2', baseVersion: 1,
      ops: [{ type: 'update', id: 'line-2', text: 'newest [Other]' }],
      actorId: 'actor-1', now: 300,
    });
    const stale = await storage.deletePage({
      projectId: 'project-1', pageId: 'page-1', baseVersion: 1, actorId: 'actor-1', now: 400,
    });
    assert.equal(stale.kind, 'conflict');
    assert.deepEqual((await storage.getPageById('page-1'))?.lines.map((line) => line.text), [
      'Home',
      'newest [Other]',
    ]);
    assert.equal(await tableCount(db, 'commits'), 2);
    assert.equal(await tableCount(db, 'links', 'WHERE source_page_id = ?', 'page-1'), 1);
    assert.equal((await storage.search('project-1', parseSearchQuery('newest'))).length, 1);

    assert.deepEqual(await storage.deletePage({
      projectId: 'project-1', pageId: 'page-1', baseVersion: 2, actorId: 'actor-1', now: 500,
    }), { kind: 'applied', version: 3 });
    const deleted = await storage.getPageById('page-1');
    assert.equal(deleted?.deleted, true);
    assert.equal(deleted?.version, 3);
    assert.deepEqual(deleted?.lines, []);
    assert.equal(await tableCount(db, 'commits'), 3);
    assert.equal(await tableCount(db, 'links', 'WHERE source_page_id = ?', 'page-1'), 0);
    assert.equal((await storage.search('project-1', parseSearchQuery('newest'))).length, 0);
  } finally {
    await server.close();
  }
});

void test('D1 rename updates the target and every backlink atomically', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'see [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });

    assert.deepEqual(await storage.renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    }), {
      kind: 'applied',
      version: 2,
      rewritten: [{ pageId: 'source', title: 'Source', version: 2 }],
    });
    assert.equal((await storage.getPageById('target'))?.title, 'New');
    assert.deepEqual((await storage.getPageById('source'))?.lines.map((line) => line.text), [
      'Source',
      'see [New]',
    ]);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 0);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'new'), 1);
  } finally {
    await server.close();
  }
});

void test('D1 commit, delete, and rename advance the project page mutation revision', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    const revision = async (): Promise<number> => (await db.prepare(
      'SELECT revision FROM page_mutation_revisions WHERE project_id = ?',
    ).bind('project-1').first<{ revision: number }>())?.revision ?? 0;
    assert.equal(await revision(), 0);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    assert.equal(await revision(), 1);
    await storage.commit({
      projectId: 'project-1', pageId: 'deleted', commitId: 'commit-deleted', baseVersion: 0,
      ops: [{ type: 'insert', id: 'deleted-title', after: '_head', text: 'Deleted' }],
      actorId: 'actor-1', now: 100,
    });
    assert.equal(await revision(), 2);
    await storage.deletePage({
      projectId: 'project-1', pageId: 'deleted', baseVersion: 1, actorId: 'actor-1', now: 150,
    });
    assert.equal(await revision(), 3);
    await storage.renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: false, actorId: 'actor-1', now: 200,
    });
    assert.equal(await revision(), 4);
  } finally {
    await server.close();
  }
});

void test('D1 rename confirms every commit after the batch response is lost', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'see [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let loseNextBatchResponse = true;
    const responseLossDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      async batch<T = unknown>(statements: Parameters<D1Binding['batch']>[0]) {
        const result = await db.batch<T>(statements);
        if (loseNextBatchResponse) {
          loseNextBatchResponse = false;
          throw new Error('batch response lost');
        }
        return result;
      },
    };

    assert.deepEqual(await new D1Storage(responseLossDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    }), {
      kind: 'applied',
      version: 2,
      rewritten: [{ pageId: 'source', title: 'Source', version: 2 }],
    });
    assert.equal((await storage.getPageById('target'))?.title, 'New');
    assert.equal((await storage.getPageById('target'))?.version, 2);
    assert.equal((await storage.getPageById('source'))?.lines[1]?.text, 'see [New]');
    assert.equal((await storage.getPageById('source'))?.version, 2);
    assert.equal(await tableCount(db, 'commits'), 4);
  } finally {
    await server.close();
  }
});

void test('D1 rename retries when a new backlink is committed after its snapshot', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'first [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let intercepted = false;
    const overlappingDb: D1Binding = {
      prepare(query) {
        const statement = db.prepare(query);
        if (!query.includes('SELECT source_page_id FROM links')) return statement;
        const wrap = (current: typeof statement): typeof statement => ({
          bind(...values) { return wrap(current.bind(...values)); },
          first<T>() { return current.first<T>(); },
          async all<T>() {
            const rows = await current.all<T>();
            if (!intercepted) {
              intercepted = true;
              await storage.commit({
                projectId: 'project-1', pageId: 'late-source', commitId: 'commit-late', baseVersion: 0,
                ops: [
                  { type: 'insert', id: 'late-title', after: '_head', text: 'Late' },
                  { type: 'insert', id: 'late-body', after: 'late-title', text: 'late [Old]' },
                ],
                actorId: 'actor-1', now: 150,
              });
            }
            return rows;
          },
          run<T>() { return current.run<T>(); },
        });
        return wrap(statement);
      },
      batch: (statements) => db.batch(statements),
    };

    const result = await new D1Storage(overlappingDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    });
    assert.equal(result.kind, 'applied');
    assert.deepEqual((await storage.getPageById('source'))?.lines.map((line) => line.text), [
      'Source',
      'first [New]',
    ]);
    assert.deepEqual((await storage.getPageById('late-source'))?.lines.map((line) => line.text), [
      'Late',
      'late [New]',
    ]);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 0);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'new'), 2);
    assert.equal(await tableCount(db, 'commits'), 6);
  } finally {
    await server.close();
  }
});

void test('D1 rename does not overwrite a backlink page changed after its snapshot', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'before [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let intercepted = false;
    const overlappingDb: D1Binding = {
      prepare(query) {
        const statement = db.prepare(query);
        if (!query.includes('SELECT source_page_id FROM links')) return statement;
        const wrap = (current: typeof statement): typeof statement => ({
          bind(...values) { return wrap(current.bind(...values)); },
          first<T>() { return current.first<T>(); },
          async all<T>() {
            const rows = await current.all<T>();
            if (!intercepted) {
              intercepted = true;
              await storage.commit({
                projectId: 'project-1', pageId: 'source', commitId: 'commit-concurrent', baseVersion: 1,
                ops: [{ type: 'update', id: 'source-body', text: 'latest [Old]' }],
                actorId: 'actor-1', now: 150,
              });
            }
            return rows;
          },
          run<T>() { return current.run<T>(); },
        });
        return wrap(statement);
      },
      batch: (statements) => db.batch(statements),
    };

    assert.equal((await new D1Storage(overlappingDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    })).kind, 'applied');
    const source = await storage.getPageById('source');
    assert.equal(source?.version, 3);
    assert.deepEqual(source?.lines.map((line) => line.text), ['Source', 'latest [New]']);
    assert.equal((await storage.search('project-1', parseSearchQuery('latest')))[0]?.pageId, 'source');
    assert.equal((await storage.search('project-1', parseSearchQuery('before'))).length, 0);
    assert.equal(await tableCount(db, 'commits', 'WHERE page_id = ?', 'source'), 3);
  } finally {
    await server.close();
  }
});

void test('D1 rename does not overwrite pinned state changed after its backlink snapshot', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'see [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });
    let intercepted = false;
    const overlappingDb: D1Binding = {
      prepare(query) {
        const statement = db.prepare(query);
        if (!query.includes('SELECT source_page_id FROM links')) return statement;
        const wrap = (current: typeof statement): typeof statement => ({
          bind(...values) { return wrap(current.bind(...values)); },
          first<T>() { return current.first<T>(); },
          async all<T>() {
            const rows = await current.all<T>();
            if (!intercepted) {
              intercepted = true;
              await storage.setPinned('source', true);
            }
            return rows;
          },
          run<T>() { return current.run<T>(); },
        });
        return wrap(statement);
      },
      batch: (statements) => db.batch(statements),
    };

    assert.equal((await new D1Storage(overlappingDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    })).kind, 'applied');
    const source = await storage.getPageById('source');
    assert.equal(source?.pinned, 1);
    assert.equal(source?.version, 2);
    assert.equal(source?.lines[1]?.text, 'see [New]');
  } finally {
    await server.close();
  }
});

void test('D1 rename rolls back the target and every backlink on an intermediate failure', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    await storage.commit({
      projectId: 'project-1', pageId: 'source', commitId: 'commit-source', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'source-title', after: '_head', text: 'Source' },
        { type: 'insert', id: 'source-body', after: 'source-title', text: 'before [Old]' },
      ],
      actorId: 'actor-1', now: 100,
    });
    const failingDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch(statements) {
        const failure = db.prepare('INSERT INTO page_mutation_guard (locked) VALUES (0)');
        return db.batch([...statements.slice(0, 7), failure, ...statements.slice(7)]);
      },
    };

    await assert.rejects(new D1Storage(failingDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    }), StorageError);
    assert.equal((await storage.getPageById('target'))?.title, 'Old');
    assert.equal((await storage.getPageById('target'))?.version, 1);
    assert.deepEqual((await storage.getPageById('source'))?.lines.map((line) => line.text), [
      'Source',
      'before [Old]',
    ]);
    assert.equal((await storage.getPageById('source'))?.version, 1);
    assert.equal(await tableCount(db, 'commits'), 2);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 1);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'new'), 0);
    assert.equal((await storage.search('project-1', parseSearchQuery('before'))).length, 1);
  } finally {
    await server.close();
  }
});

void test('D1 rename surfaces an unexpected unique constraint failure without retrying it as a guard conflict', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    let batchCalls = 0;
    const failingDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch(statements) {
        batchCalls += 1;
        const failure = db.prepare(
          `INSERT INTO projects (id, name, display_name, created, updated)
           VALUES ('project-1', 'duplicate', 'duplicate', 1, 1)`,
        );
        return db.batch([...statements.slice(0, 7), failure, ...statements.slice(7)]);
      },
    };

    await assert.rejects(new D1Storage(failingDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: false, actorId: 'actor-1', now: 200,
    }), /UNIQUE constraint failed/u);
    assert.equal(batchCalls, 1);
    assert.equal((await storage.getPageById('target'))?.title, 'Old');
    assert.equal((await storage.getPageById('target'))?.version, 1);
    assert.equal(await tableCount(db, 'commits'), 1);
  } finally {
    await server.close();
  }
});

void test('D1 rename preserves stale, title-conflict, and rewriteLinks false semantics', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await assertRenameConflictContract(storage, 'project-1', 'actor-1');
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 1);
    assert.equal(await tableCount(db, 'commits'), 4);
  } finally {
    await server.close();
  }
});

void test('D1 rename query shape stays fixed as backlinks grow and remains within Free limits', async () => {
  const { server, db } = await testDatabase();
  try {
    const measurements: QueryMeasurements[] = [];
    for (const [projectId, sourceCount] of [['project-small', 1], ['project-large', 20]] as const) {
      await db.prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
        .bind(projectId, projectId, projectId, 100, 100).run();
      const storage = new D1Storage(db);
      await storage.commit({
        projectId, pageId: `${projectId}-target`, commitId: `${projectId}-target-commit`, baseVersion: 0,
        ops: [{ type: 'insert', id: `${projectId}-target-title`, after: '_head', text: 'Old' }],
        actorId: 'actor-1', now: 100,
      });
      for (let index = 0; index < sourceCount; index += 1) {
        const pageId = `${projectId}-source-${index}`;
        await storage.commit({
          projectId, pageId, commitId: `${pageId}-commit`, baseVersion: 0,
          ops: [
            { type: 'insert', id: `${pageId}-title`, after: '_head', text: `Source ${index}` },
            { type: 'insert', id: `${pageId}-body`, after: `${pageId}-title`, text: `line ${index} [Old]` },
          ],
          actorId: 'actor-1', now: 100,
        });
      }
      const measured = countQueries(db);
      assert.equal((await new D1Storage(measured.binding).renamePage({
        projectId, pageId: `${projectId}-target`, baseVersion: 1, newTitle: 'New',
        rewriteLinks: true, actorId: 'actor-1', now: 200,
      })).kind, 'applied');
      measurements.push(measured.measurements());
    }
    const [small, large] = measurements;
    assert.ok(small);
    assert.ok(large);
    assert.deepEqual(
      { queries: large.queries, batchStatements: large.batchStatements, maxParameters: large.maxParameters },
      { queries: small.queries, batchStatements: small.batchStatements, maxParameters: small.maxParameters },
    );
    assert.ok(large.queries <= 50);
    assert.equal(large.largeBoundStrings, 1);
    assert.ok(large.maxParameters <= 100);
    assert.ok(large.maxStatementBytes <= 100_000);
    assert.ok(large.maxBoundStringBytes <= 2_000_000);
  } finally {
    await server.close();
  }
});

void test('D1 rename rejects an oversized atomic payload without partial mutation', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'target', commitId: 'commit-target', baseVersion: 0,
      ops: [{ type: 'insert', id: 'target-title', after: '_head', text: 'Old' }],
      actorId: 'actor-1', now: 100,
    });
    for (let index = 0; index < 5; index += 1) {
      const pageId = `source-${index}`;
      const body = `${'x'.repeat(440_000)} [Old]`;
      await db.batch([
        db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, NULL, 100, 100)')
          .bind(pageId, 'project-1', `Source ${index}`, `source_${index}`),
        db.prepare(
          'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 0, ?, 100, 100, 1, ?)',
        ).bind(`${pageId}-title`, pageId, `Source ${index}`, 'actor-1'),
        db.prepare(
          'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 1, ?, 100, 100, 1, ?)',
        ).bind(`${pageId}-body`, pageId, body, 'actor-1'),
        db.prepare(
          'INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash) VALUES (?, ?, 0, 1, ?, 100, ?, ?)',
        ).bind(`${pageId}-commit`, pageId, 'actor-1', '[]', `${pageId}-hash`),
        db.prepare('INSERT INTO links VALUES (?, ?, ?, ?)').bind('project-1', pageId, 'old', 'Old'),
      ]);
    }
    const preflightDb: D1Binding = {
      prepare(query) {
        if (query.includes('WHERE p.id IN')) throw new Error('full backlink snapshot should not be read');
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };

    await assert.rejects(new D1Storage(preflightDb).renamePage({
      projectId: 'project-1', pageId: 'target', baseVersion: 1, newTitle: 'New',
      rewriteLinks: true, actorId: 'actor-1', now: 200,
    }), (error: unknown) => error instanceof BadCommitError
      && error.message === 'rename is too large for one atomic D1 mutation');
    assert.equal((await storage.getPageById('target'))?.title, 'Old');
    assert.equal((await storage.getPageById('target'))?.version, 1);
    assert.equal(await tableCount(db, 'commits'), 6);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 5);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'new'), 0);
  } finally {
    await server.close();
  }
});

void test('D1 batch constraint failure leaves no partial page mutation', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = await seedMutationProject(db);
    await storage.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-1', baseVersion: 0,
      ops: [
        { type: 'insert', id: 'line-1', after: '_head', text: 'Home' },
        { type: 'insert', id: 'line-2', after: 'line-1', text: 'before [Old]' },
      ],
      actorId: 'actor-1', now: 200,
    });
    const failingDb: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch(statements) {
        const failure = db.prepare('INSERT INTO page_mutation_guard (locked) VALUES (0)');
        return db.batch([...statements.slice(0, 6), failure, ...statements.slice(6)]);
      },
    };
    const failingStorage = new D1Storage(failingDb);
    await assert.rejects(failingStorage.commit({
      projectId: 'project-1', pageId: 'page-1', commitId: 'commit-2', baseVersion: 1,
      ops: [{ type: 'update', id: 'line-2', text: 'after [New]' }],
      actorId: 'actor-1', now: 300,
    }), StorageError);
    const page = await storage.getPageById('page-1');
    assert.equal(page?.version, 1);
    assert.deepEqual(page?.lines.map((line) => line.text), ['Home', 'before [Old]']);
    assert.equal(await tableCount(db, 'commits'), 1);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'old'), 1);
    assert.equal(await tableCount(db, 'links', 'WHERE target_title_lc = ?', 'new'), 0);
    assert.equal((await storage.search('project-1', parseSearchQuery('before'))).length, 1);
    assert.equal((await storage.search('project-1', parseSearchQuery('after'))).length, 0);
  } finally {
    await server.close();
  }
});

void test('D1 commit statement shape stays fixed as the page grows and remains within D1 limits', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
      .bind('project-1', 'wiki', 'wiki', 100, 100).run();
    const measured = countQueries(db);
    const storage = new D1Storage(measured.binding);
    const measurements: QueryMeasurements[] = [];
    for (const size of [10, 2_000]) {
      measured.reset();
      const ops = Array.from({ length: size }, (_, index) => ({
        type: 'insert' as const,
        id: `line-${size}-${index}`,
        after: index === 0 ? '_head' : `line-${size}-${index - 1}`,
        text: index === 0 ? `Dogfood ${size}` : `line ${index} [Target ${index}]`,
      }));
      assert.deepEqual(await storage.commit({
        projectId: 'project-1', pageId: `page-${size}`, commitId: `commit-${size}`, baseVersion: 0,
        ops, actorId: 'actor-1', now: 200,
      }), { kind: 'applied', version: 1 });
      measurements.push(measured.measurements());
    }
    const [small, large] = measurements;
    assert.ok(small);
    assert.ok(large);
    assert.deepEqual(
      { queries: large.queries, batchStatements: large.batchStatements, maxParameters: large.maxParameters },
      { queries: small.queries, batchStatements: small.batchStatements, maxParameters: small.maxParameters },
    );
    assert.equal(large.queries, 15);
    assert.equal(large.batchStatements, 12);
    assert.equal(large.maxStatementBytes, small.maxStatementBytes);
    for (const measurement of measurements) {
      assert.ok(measurement.maxStatementBytes <= 100_000);
      assert.ok(measurement.maxBoundStringBytes <= 2_000_000);
    }
  } finally {
    await server.close();
  }
});

void test('D1 adapter provides identity, project, page reads, related pages, visits, and search', async () => {
  const { server, db } = await testDatabase();
  try {
    const storage = new D1Storage(db);
    const accessAccount = {
      id: 'account-1',
      actor: { id: 'actor-2', name: 'owner', displayName: 'Owner' },
      name: 'owner',
      email: 'owner@example.com',
    };
    const ids = await storage.addAccessAccount(accessAccount, 100);
    assert.deepEqual(ids, { accountId: 'account-1', actorId: 'actor-2' });
    assert.deepEqual(await storage.addAccessAccount(accessAccount, 200), ids);
    assert.equal((await storage.getAccountById('account-1'))?.actorId, 'actor-2');
    assert.equal((await storage.getAccountById('account-1'))?.passwordHash, null);
    assert.equal((await storage.getActorById('actor-2'))?.id, 'actor-2');

    const created = await storage.createProject('project', 100);
    assert.equal(created.kind, 'created');
    assert.equal((await storage.createProject('project', 200)).kind, 'existing');
    await db.prepare('UPDATE projects SET id = ? WHERE name = ?').bind('project-1', 'project').run();
    await seedReadFixture(db);
    await storage.reindex('project-1');

    const home = await storage.getPageByTitle('project-1', 'home');
    assert.equal(home?.id, 'home');
    assert.deepEqual(home?.lines.map((line) => line.text), ['Home', '日本語の設計 [Forward] [Shared Topic] 100% A_B']);
    assert.equal((await storage.getPageAuthors('home')).lastUpdateUser?.id, 'author-1');
    assert.deepEqual((await storage.listKnownPages('project-1')).map((page) => page.title).toSorted(), [
      'Back', 'Forward', 'Home', 'Sibling',
    ]);

    const summaries = await storage.listPageSummaries('project-1', { skip: 0, limit: 10, sort: 'updated' });
    assert.equal(summaries.count, 4);
    assert.deepEqual(summaries.pages.find((page) => page.id === 'home')?.descriptions, [
      '日本語の設計 [Forward] [Shared Topic] 100% A_B',
    ]);
    const related = await storage.getRelatedPages('project-1', 'home', 'home');
    assert.deepEqual(related.links1hop.map((page) => page.title).toSorted(), ['Back', 'Forward']);
    assert.deepEqual(related.links2hop.map((page) => page.title), ['Sibling']);
    assert.equal(related.hasBackLinks, true);

    await storage.recordVisit('account-1', 'home', 200, 1);
    await storage.recordVisit('account-1', 'home', 190, 0);
    assert.deepEqual(await storage.getVisit('account-1', 'home'), { visited: 200, lastSeenVersion: 1 });
    assert.deepEqual(await storage.getPageVisitMetrics('home'), { views: 2, accessed: 200 });

    const search = await storage.search('project-1', parseSearchQuery('設計 検索'));
    assert.deepEqual(search.map((hit) => hit.pageId), ['forward']);
    assert.deepEqual(await storage.search('project-1', parseSearchQuery('設計 -検索')), [{
      pageId: 'home',
      title: 'Home',
      image: null,
      lines: ['日本語の設計 [Forward] [Shared Topic] 100% A_B'],
    }]);
    assert.deepEqual((await storage.search('project-1', parseSearchQuery('%'))).map((hit) => hit.pageId), ['home']);
    assert.deepEqual((await storage.search('project-1', parseSearchQuery('_'))).map((hit) => hit.pageId), ['home']);

    const app = createCloudflareApp(
      { storage, config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] } },
      access,
      accessKey,
    );
    const token = await accessToken();
    const pageResponse = await app.request('/project/Home', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    assert.equal(pageResponse.status, 200);
    const mutationResponse = await app.request('/api/knot/pages/project/Home/commits', {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': token,
        'Content-Type': 'application/json',
        'X-Knot-Client': 'test',
      },
      body: JSON.stringify({
        pageId: 'home',
        commitId: 'new',
        baseVersion: 1,
        ops: [{ type: 'update', id: 'home-100', text: 'changed' }],
      }),
    });
    assert.equal(mutationResponse.status, 200);
    assert.deepEqual(await mutationResponse.json(), { version: 2, pageId: 'home' });
    await db.prepare('UPDATE pages SET deleted = 1 WHERE id = ?').bind('forward').run();
    assert.equal((await storage.reindex('project-1')).pages, 4);
    assert.deepEqual(await storage.search('project-1', parseSearchQuery('検索')), []);
    await assert.rejects(
      storage.commit({ projectId: 'project-1', pageId: 'home', commitId: 'new', baseVersion: 1, ops: [], actorId: 'actor-2', now: 300 }),
      BadCommitError,
    );
  } finally {
    await server.close();
  }
});

void test('related pages supports more links than the D1 bound-parameter limit', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').bind('project-1', 'project', 'Project').run();
    await seedReadFixture(db);
    await seedManyLinkedPages(db, 120);
    const measured = countQueries(db);
    const related = await new D1Storage(measured.binding).getRelatedPages('project-1', 'home', 'home');
    assert.equal(related.links1hop.length, 122);
    assert.equal(measured.count(), 2);
  } finally {
    await server.close();
  }
});

void test('dogfood read and search operations stay within the D1 Free query budget', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').bind('project-1', 'project', 'Project').run();
    await new D1Storage(db).addAccessAccount({
      id: 'account-1',
      actor: { id: 'actor-2', name: 'owner', displayName: 'Owner' },
      name: 'owner',
      email: 'owner@example.com',
    }, 100);
    await seedReadFixture(db);
    await seedManyLinkedPages(db, 60);
    const measured = countQueries(db);
    const storage = new D1Storage(measured.binding);
    await storage.reindex('project-1');

    measured.reset();
    await storage.listPageSummaries('project-1', { skip: 0, limit: 100, sort: 'updated' });
    assert.equal(measured.count(), 2);

    measured.reset();
    await storage.listPageTitles('project-1');
    assert.equal(measured.count(), 1);

    measured.reset();
    await storage.search('project-1', parseSearchQuery('shared'));
    assert.equal(measured.count(), 1);

    const app = createCloudflareApp(
      { storage, config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] } },
      access,
      accessKey,
    );
    const token = await accessToken();
    for (const [path, expectedQueries] of [
      ['/project/Home', 10],
      ['/api/pages/project/Home', 9],
      ['/api/pages/project', 5],
      ['/api/pages/project/search/query?q=shared', 4],
    ] as const) {
      measured.reset();
      const response = await app.request(path, { headers: { 'Cf-Access-Jwt-Assertion': token } });
      assert.equal(response.status, 200, path);
      assert.equal(measured.count(), expectedQueries, path);
    }
  } finally {
    await server.close();
  }
});

void test('D1 search preserves the SQLite adapter result order', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').bind('project-1', 'project', 'Project').run();
    await db.prepare('INSERT INTO actors VALUES (?, ?, ?, 1)').bind('author-1', 'author', 'Author').run();
    const statements = [];
    for (const [id, updated, content] of [
      ['alpha', 300, 'shared'],
      ['bravo', 200, 'shared shared shared'],
      ['charlie', 100, 'shared'],
    ] as const) {
      statements.push(
        db.prepare('INSERT INTO pages VALUES (?, ?, ?, ?, 1, 0, 0, NULL, 1, ?)')
          .bind(id, 'project-1', id, id, updated),
        db.prepare(
          'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 0, ?, 1, 1, 1, ?)',
        ).bind(`${id}-title`, id, id, 'author-1'),
        db.prepare(
          'INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id) VALUES (?, ?, 1, ?, 1, 1, 1, ?)',
        ).bind(`${id}-body`, id, content, 'author-1'),
      );
    }
    await db.batch(statements);
    const storage = new D1Storage(db);
    await storage.reindex('project-1');
    for (const query of ['shared', 'shared alpha', 'shared -bravo']) {
      assert.deepEqual(
        (await storage.search('project-1', parseSearchQuery(query))).map((hit) => hit.pageId),
        await sqliteSearchOrder(query),
        query,
      );
    }
  } finally {
    await server.close();
  }
});

void test('D1 and SQLite adapters expose the same page read contract', async () => {
  const { server, db: d1 } = await testDatabase();
  const { db: sqlite, storage: sqliteStorage } = makeStorage();
  try {
    const account = {
      id: 'account-1',
      actor: { id: 'actor-2', name: 'owner', displayName: 'Owner' },
      name: 'owner',
      email: 'owner@example.com',
    };
    await d1.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').bind('project-1', 'project', 'Project').run();
    await new D1Storage(d1).addAccessAccount(account, 100);
    await seedReadFixture(d1);
    await new D1Storage(d1).reindex('project-1');

    sqlite.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').run('project-1', 'project', 'Project');
    await sqliteStorage.addAccount({ ...account, passwordHash: 'hash', isAdmin: true }, 100);
    seedSqliteReadFixture(sqlite);
    await sqliteStorage.reindex('project-1');

    const d1Storage = new D1Storage(d1);
    await d1Storage.recordVisit('account-1', 'home', 200, 1);
    await sqliteStorage.recordVisit('account-1', 'home', 200, 1);
    assert.deepEqual(await readContract(d1Storage), await readContract(sqliteStorage));
  } finally {
    await sqliteStorage.close();
    await server.close();
  }
});

void test('D1 reindex keeps each page in a separate batch', async () => {
  const { server, db } = await testDatabase();
  try {
    await db.prepare('INSERT INTO projects VALUES (?, ?, ?, 1, 1)').bind('project-1', 'project', 'Project').run();
    await seedReadFixture(db);
    const batchSizes: number[] = [];
    const measured: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch: (statements) => {
        batchSizes.push(statements.length);
        return db.batch(statements);
      },
    };
    await new D1Storage(measured).reindex('project-1');
    assert.equal(batchSizes.length, 4);
  } finally {
    await server.close();
  }
});

void test('application keeps Hono default 500 behavior for unrelated errors', async (t) => {
  const { server, db } = await testDatabase();
  t.mock.method(console, 'error', () => undefined);
  try {
    class FailingStorage extends D1Storage {
      override async getProject(): Promise<never> {
        throw new Error('unexpected storage failure');
      }
    }
    const baseStorage = new D1Storage(db);
    await baseStorage.addAccessAccount({
      id: 'account-1',
      actor: { id: 'actor-2', name: 'owner', displayName: 'Owner' },
      name: 'owner',
      email: 'owner@example.com',
    }, 100);
    const app = createCloudflareApp(
      {
        storage: new FailingStorage(db),
        config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] },
      },
      access,
      accessKey,
    );
    const response = await app.request('/api/pages/project', {
      headers: { 'Cf-Access-Jwt-Assertion': await accessToken() },
    });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Internal Server Error');
  } finally {
    await server.close();
  }
});

void test('Access bootstrap maps only D1 unique conflicts to StorageError', async () => {
  const { server, db } = await testDatabase();
  const account = {
    id: 'account-1',
    actor: { id: 'actor-2', name: 'owner', displayName: 'Owner' },
    name: 'owner',
    email: 'owner@example.com',
  };
  try {
    const uniqueFailure = new Error('D1_ERROR: UNIQUE constraint failed: accounts.name: SQLITE_CONSTRAINT');
    const uniqueBinding: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch: async () => { throw uniqueFailure; },
    };
    await assert.rejects(new D1Storage(uniqueBinding).addAccessAccount(account, 100), StorageError);

    const checkFailure = new Error('D1_ERROR: CHECK constraint failed: SQLITE_CONSTRAINT');
    const checkBinding: D1Binding = {
      prepare: (query) => db.prepare(query),
      batch: async () => { throw checkFailure; },
    };
    await assert.rejects(
      new D1Storage(checkBinding).addAccessAccount(account, 100),
      (error) => error === checkFailure,
    );
  } finally {
    await server.close();
  }
});
