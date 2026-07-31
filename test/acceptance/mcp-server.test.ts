import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import type { Storage } from '../../src/storage/types.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/password.ts';
import { ulid } from '../../src/core/id.ts';
import { seedPage } from '../helpers/pages.ts';

const certPath = fileURLToPath(new URL('../fixtures/tls/localhost-cert.pem', import.meta.url));
const keyPath = fileURLToPath(new URL('../fixtures/tls/localhost-key.pem', import.meta.url));

/** scrapbox-cosense-mcp の bin 実体を package.json の bin フィールドから解決する */
function resolveMcpBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('scrapbox-cosense-mcp/package.json');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> };
  const rel = pkg.bin['scrapbox-cosense-mcp'];
  assert.ok(rel, 'scrapbox-cosense-mcp package.json に bin がない');
  return join(dirname(pkgPath), rel);
}

/** MCP の CallTool 応答から text content を連結して返す */
function textOf(result: unknown): string {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content), 'MCP 応答に content 配列がない');
  const texts = content
    .filter((c): c is { type: string; text: string } =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
    .map((c) => c.text);
  assert.ok(texts.length > 0, 'MCP 応答に text content がない');
  return texts.join('\n');
}

void test('scrapbox-cosense-mcp が knot に対して list_pages / get_page / search_pages を実行できる', { timeout: 90_000 }, async () => {
  const t = 1_700_000_000;
  const storage: Storage = new SqliteStorage(openDatabase(':memory:'));
  let server: ReturnType<typeof serve> | undefined;
  let client: Client | undefined;
  try {
    const config = { ...defaultConfig('/nonexistent'), secureCookie: false };
    const app = createApp({ storage, config, now: () => t });

  // seed: プロジェクト・ページ・ユーザー・セッション
  const project = await storage.ensureProject('sandbox', t);
  // seedPage はコミット userId 'u' を使う。実運用同様に user が解決できるよう表示ユーザーを登録する
  await storage.upsertDisplayUser({ id: 'u', name: 'editor', displayName: 'Editor' }, t);
  await seedPage(storage, project.id, 'Alpha', ['hello from alpha', 'second line'], t);
  await seedPage(storage, project.id, 'SearchTarget', ['this page contains mcpaccepttoken here'], t + 1);
  const userId = ulid(t * 1000);
  await storage.addUser(
    { id: userId, name: 'alice', displayName: 'alice', passwordHash: hashPassword('pw12345678'), isAdmin: false },
    t,
  );
  const sid = randomBytes(16).toString('hex');
  await storage.createSession({ id: sid, userId, expires: t + 30 * 24 * 60 * 60, created: t });

  // HTTPS で実 listener を起動（port 0 → 実ポートを取得）
    const listener = serve({
      fetch: app.fetch,
      hostname: '127.0.0.1',
      port: 0,
      createServer,
      serverOptions: { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    });
    server = listener;
    await new Promise<void>((resolve) => {
      listener.on('listening', () => resolve());
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const port = (listener.address() as AddressInfo).port;

    client = new Client({ name: 'knot-acceptance', version: '0.0.0' });
    // StdioClientTransport の env はプロセス環境を継承しないため PATH を明示する
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolveMcpBin()],
      env: {
        PATH: process.env.PATH ?? '',
        API_DOMAIN: `127.0.0.1:${port}`,
        COSENSE_PROJECT_NAME: 'sandbox',
        COSENSE_SID: sid,
        NODE_EXTRA_CA_CERTS: certPath,
      },
    });
    await client.connect(transport);

    const list = textOf(await client.callTool({ name: 'list_pages', arguments: {} }));
    assert.match(list, /Alpha/);
    assert.match(list, /SearchTarget/);

    const page = textOf(await client.callTool({ name: 'get_page', arguments: { pageTitle: 'Alpha' } }));
    assert.match(page, /hello from alpha/);
    assert.match(page, /second line/);

    const found = textOf(await client.callTool({ name: 'search_pages', arguments: { query: 'mcpaccepttoken' } }));
    assert.match(found, /SearchTarget/);
  } finally {
    try {
      if (client !== undefined) await client.close();
    } finally {
      try {
        if (server !== undefined) {
          await new Promise<void>((resolve, reject) => {
            server!.close((err) => (err ? reject(err) : resolve()));
          });
        }
      } finally {
        await storage.close();
      }
    }
  }
});
