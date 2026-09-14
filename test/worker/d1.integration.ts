import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTestHarness } from 'wrangler';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';
import { D1Storage, type D1Binding } from '../../src/storage/d1.ts';
import {
  StorageError,
  UnsupportedStorageOperationError,
  type RelatedPages,
  type Storage,
} from '../../src/storage/types.ts';
import { createCloudflareApp } from '../../src/worker/app.ts';
import { makeStorage } from '../helpers/storage.ts';

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

function normalizeRelatedPages(pages: RelatedPages['links1hop']): RelatedPages['links1hop'] {
  return pages.map((page) => ({
    ...page,
    linksLc: page.linksLc.toSorted(),
  })).toSorted((left, right) => left.id.localeCompare(right.id));
}

function normalizedRelated(related: RelatedPages): RelatedPages {
  return {
    ...related,
    links1hop: normalizeRelatedPages(related.links1hop),
    links2hop: normalizeRelatedPages(related.links2hop),
  };
}

async function readContract(storage: Storage) {
  const searches = await Promise.all(['設計', '設計 検索', '設計 -検索', 'shared'].map(async (query) => ({
    query,
    hits: await storage.search('project-1', parseSearchQuery(query)),
  })));
  return {
    page: await storage.getPageById('home'),
    pages: await storage.listPages('project-1'),
    related: normalizedRelated(await storage.getRelatedPages('project-1', 'home', 'home')),
    visit: await storage.getVisit('account-1', 'home'),
    searches,
  };
}

function countQueries(db: D1Binding): { binding: D1Binding; count: () => number; reset: () => void } {
  let count = 0;
  return {
    binding: {
      prepare(query) {
        count += 1;
        return db.prepare(query);
      },
      batch(statements) {
        return db.batch(statements);
      },
    },
    count: () => count,
    reset: () => { count = 0; },
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
    ]);
    assert.notEqual(await partialDb.prepare("SELECT name FROM sqlite_master WHERE name = 'pages'").first(), null);
  } finally {
    await partialServer.close();
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
    assert.equal(mutationResponse.status, 501);
    assert.deepEqual(await mutationResponse.json(), {
      error: 'storage_operation_unavailable',
      message: 'storage operation is not implemented yet: commit',
    });
    await db.prepare('UPDATE pages SET deleted = 1 WHERE id = ?').bind('forward').run();
    assert.equal((await storage.reindex('project-1')).pages, 4);
    assert.deepEqual(await storage.search('project-1', parseSearchQuery('検索')), []);
    await assert.rejects(
      storage.commit({ projectId: 'project-1', pageId: 'home', commitId: 'new', baseVersion: 1, ops: [], actorId: 'actor-2', now: 300 }),
      UnsupportedStorageOperationError,
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
      ['/project/Home', 11],
      ['/api/pages/project/Home', 10],
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
