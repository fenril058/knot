import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTestHarness } from 'wrangler';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';
import { D1Storage, type D1Binding } from '../../src/storage/d1.ts';
import { UnsupportedStorageOperationError } from '../../src/storage/types.ts';
import { createCloudflareApp } from '../../src/worker/app.ts';

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

void test('D1 migrations are forward-only, repeatable, and upgrade a partially migrated database', async () => {
  const { server, db } = await testDatabase();
  try {
    const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    assert.deepEqual(applied.results.map((row) => row.name), [
      '0001_identity_projects.sql',
      '0002_page_reads.sql',
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
    await applySql(
      `CREATE TABLE d1_migrations(
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
       );
       INSERT INTO d1_migrations (name) VALUES ('0001_identity_projects.sql');`,
    );
    await worker.applyD1Migrations('DB');
    const upgraded = await partialDb.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    assert.deepEqual(upgraded.results.map((row) => row.name), [
      '0001_identity_projects.sql',
      '0002_page_reads.sql',
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
