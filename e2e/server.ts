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
  'geometry-e2e',
  'geometry-mobile-e2e',
  'line-e2e',
  'line-mobile-e2e',
  'cards-e2e',
  'cards-mobile-e2e',
  'telomere-e2e',
  'telomere-mobile-e2e',
  'active-line-e2e',
  'caret-e2e',
  'caret-mobile-e2e',
  'search-e2e',
  'search-mobile-e2e',
  'page-menu-e2e',
  'selection-e2e',
  'table-e2e',
  'related-e2e',
  'related-mobile-e2e',
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

// タイトルと本文の行を 1 コミットで書き、ページを作る。at がページの作成・更新の日時になる。
async function seedPage(projectId: string, lines: string[], at: number): Promise<string> {
  const pageId = ulid();
  let after = '_head';
  const ops = lines.map((text) => {
    const id = ulid();
    const op = { type: 'insert' as const, id, after, text };
    after = id;
    return op;
  });
  await storage.commit({ projectId, pageId, commitId: ulid(), baseVersion: 0, ops, actorId: 'e2e', now: at });
  return pageId;
}

// ピン留めは HTTP API から設定できないので、カードの e2e（e2e/cards.spec.ts）が使う
// ピン留めのページをここで用意する。
const pinnedProject = await storage.ensureProject('e2e-pinned', now);
for (const [title, pinned] of [['pinned card', true], ['plain card', false]] as const) {
  const pageId = await seedPage(pinnedProject.id, [title, `${title} の説明`], now);
  if (pinned) await storage.setPinned(pageId, true);
}

// 関連ページの並び替えと絞り込みの e2e（e2e/related.spec.ts と e2e/mobile.spec.ts）が使うページ。
// 札の更新日時を決めておくため、HTTP API ではなくここで作る。rel-base から見た関連度の順は
// bravo（rel-base にリンクする）・alpha・charlie、更新日時の順は alpha・charlie・bravo。
// 2-hop の rel-alpha の行は、関連度と更新日時の順が zulu・yankee、タイトルの順が yankee・zulu。
const relatedProject = await storage.ensureProject('e2e-related', now);
for (const [lines, at] of [
  [['rel-alpha', 'alpha の説明'], now - 100],
  [['rel-bravo', '[rel-base] へ戻る', 'bravo の説明'], now - 300],
  [['rel-charlie', 'needle を含む説明'], now - 200],
  [['rel-two-zulu', '[rel-alpha] を共有する'], now - 50],
  [['rel-two-yankee', '[rel-alpha] を共有する'], now - 400],
  [['rel-base', '[rel-alpha] [rel-bravo] [rel-charlie]'], now],
] as const) {
  await seedPage(relatedProject.id, [...lines], at);
}

const port = Number(process.env.E2E_PORT ?? 4173);
serve({ fetch: createApp({ storage, config }).fetch, port, hostname: '127.0.0.1' });
console.log(`knot e2e server: http://127.0.0.1:${port}/ (data: ${dataDir})`);
