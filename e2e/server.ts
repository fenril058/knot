// Playwright の webServer が起動する e2e 用サーバ。一時 data dir に DB を作り、
// ユーザー e2e / プロジェクト e2e を seed して 127.0.0.1 で serve する。
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { ulid } from '../src/core/id.ts';
import { createApp } from '../src/server/app.ts';
import { defaultConfig } from '../src/server/config.ts';
import { hashPassword } from '../src/server/password.ts';
import { openDatabase } from '../src/storage/db.ts';
import { SqliteStorage } from '../src/storage/sqlite.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'knot-e2e-'));
mkdirSync(join(dataDir, 'files'), { recursive: true });

const storage = new SqliteStorage(openDatabase(join(dataDir, 'knot.db')));
const config = { ...defaultConfig(dataDir), secureCookie: false };
const now = Math.floor(Date.now() / 1000);
await storage.addAccount(
  {
    id: ulid(),
    actor: { id: ulid(), name: 'e2e', displayName: 'e2e' },
    name: 'e2e',
    passwordHash: hashPassword('e2e-password'),
    isAdmin: false,
  },
  now,
);
await storage.addAccount(
  {
    id: ulid(),
    actor: { id: ulid(), name: 'project-e2e', displayName: 'project-e2e' },
    name: 'project-e2e',
    passwordHash: hashPassword('project-e2e-password'),
    isAdmin: false,
  },
  now,
);
await storage.ensureProject('e2e', now);

const port = Number(process.env.E2E_PORT ?? 4173);
serve({ fetch: createApp({ storage, config }).fetch, port, hostname: '127.0.0.1' });
console.log(`knot e2e server: http://127.0.0.1:${port}/ (data: ${dataDir})`);
