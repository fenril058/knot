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
// アカウントを題材ごとに分けるのは、login rate limit が ip と name の組で 10 分間 10 回までだから
// （src/server/app.ts の loginLimiter）。同じ name を全 spec で使うと 429 で落ちる。
// title の spec は direct-edit と mobile にまたがるので、spec ではなく題材で 1 つ分ける。
// password は `${name}-password`（e2e/helpers.ts の loginE2eAccount と対）。
const accountNames = [
  'e2e',
  'project-e2e',
  'recovery-e2e',
  'direct-edit-e2e',
  'title-e2e',
  'wrap-e2e',
  'parity-e2e',
  'quote-e2e',
  'scroll-e2e',
  'scroll-mobile-e2e',
  'link-e2e',
  'link-mobile-e2e',
];
for (const name of accountNames) {
  await storage.addAccount(
    {
      id: ulid(),
      actor: { id: ulid(), name, displayName: name },
      name,
      passwordHash: hashPassword(`${name}-password`),
      isAdmin: false,
    },
    now,
  );
}
await storage.ensureProject('e2e', now);

const port = Number(process.env.E2E_PORT ?? 4173);
serve({ fetch: createApp({ storage, config }).fetch, port, hostname: '127.0.0.1' });
console.log(`knot e2e server: http://127.0.0.1:${port}/ (data: ${dataDir})`);
