import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import type { Storage } from '../../src/storage/types.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/password.ts';
import { generateApiToken } from '../../src/server/apiToken.ts';
import { ulid } from '../../src/core/id.ts';
import { seedPage } from '../helpers/pages.ts';

const execFileAsync = promisify(execFile);

/** @helpfeel/cosense-cli の bin 実体を package.json の bin フィールドから解決する */
function resolveCosenseCliBin(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('@helpfeel/cosense-cli/package.json');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> };
  const rel = pkg.bin.cosense;
  assert.ok(rel, '@helpfeel/cosense-cli package.json に bin.cosense がない');
  return join(dirname(pkgPath), rel);
}

/** cosense CLI を子プロセスで実行し stdout/stderr を返す */
async function runCosense(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [resolveCosenseCliBin(), ...args], {
    env,
    timeout: 30_000,
  });
}

void test(
  '公式 cosense-cli(PAT認証) が knot に対して listPages / readPage / searchFullText を実行できる',
  { timeout: 60_000 },
  async (t) => {
    const at = 1_700_000_000;
    const storage: Storage = new SqliteStorage(openDatabase(':memory:'));
    let server: ReturnType<typeof serve> | undefined;
    let home: string | undefined;
    try {
      const config = { ...defaultConfig('/nonexistent'), secureCookie: false };
      const app = createApp({ storage, config, now: () => at });

    // seed: プロジェクト・ユーザー・ページ
    const project = await storage.ensureProject('sandbox', at);
    // seedPage は互換形式の userId 'u' を Actor ID として使うため、表示用 Actor を登録する。
    await storage.upsertActor({ id: 'u', name: 'editor', displayName: 'Editor' }, at);
    await seedPage(storage, project.id, 'Alpha', ['hello from alpha', 'second line'], at);
    await seedPage(storage, project.id, 'Bravo', ['bravo body text'], at + 1);
    await seedPage(storage, project.id, 'SearchTarget', ['this page contains clifulltextprobe here'], at + 2);

    // PAT を仕込む
    const accountId = ulid(at * 1000);
    await storage.addAccount(
      {
        id: accountId,
        actor: { id: ulid(at * 1000), name: 'alice', displayName: 'alice' },
        name: 'alice', passwordHash: hashPassword('pw12345678'), isAdmin: false,
      },
      at,
    );
    const { token, tokenHash } = generateApiToken();
    await storage.createApiToken({ id: ulid(at * 1000), accountId, label: 'cli', tokenHash, created: at });

    // HTTP（TLS 不要）で実 listener を起動。この CLI は http origin を受け付ける
      const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
      server = listener;
      await new Promise<void>((resolve) => {
        listener.on('listening', () => resolve());
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const port = (listener.address() as AddressInfo).port;
      const projectUrl = `http://127.0.0.1:${port}/sandbox`;

      // ~/.cosense/settings.json を読みに行かないよう HOME を空の一時ディレクトリにする
      home = mkdtempSync(join(tmpdir(), 'knot-cosense-cli-'));
      const baseEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: home,
      };

      await t.test('listPages: count と seed したタイトルが返る', async () => {
        const { stdout } = await runCosense(['listPages', projectUrl], {
          ...baseEnv,
          COSENSE_PAT: token,
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const data = JSON.parse(stdout) as { count: number; pages: { title: string }[] };
        assert.equal(data.count, 3);
        const titles = data.pages.map((p) => p.title);
        assert.ok(titles.includes('Alpha'), `Alpha not in ${JSON.stringify(titles)}`);
        assert.ok(titles.includes('Bravo'), `Bravo not in ${JSON.stringify(titles)}`);
        assert.ok(titles.includes('SearchTarget'), `SearchTarget not in ${JSON.stringify(titles)}`);
      });

      await t.test('readPage: 本文行のテキストが返る', async () => {
        const { stdout } = await runCosense(['readPage', `${projectUrl}/Alpha`], {
          ...baseEnv,
          COSENSE_PAT: token,
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const data = JSON.parse(stdout) as { lines: { text: string }[] };
        const texts = data.lines.map((l) => l.text);
        assert.ok(texts.includes('hello from alpha'));
        assert.ok(texts.includes('second line'));
      });

      await t.test('searchFullText: 一意文字列でヒットする', async () => {
        const { stdout } = await runCosense(['searchFullText', projectUrl, 'clifulltextprobe'], {
          ...baseEnv,
          COSENSE_PAT: token,
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const data = JSON.parse(stdout) as { count: number; pages: { title: string }[] };
        assert.ok(data.count >= 1);
        assert.ok(data.pages.some((p) => p.title === 'SearchTarget'));
      });

      await t.test('PAT が不正な listPages は非 0 exit + 401 を含むエラー出力', async () => {
        await assert.rejects(
          runCosense(['listPages', projectUrl], { ...baseEnv, COSENSE_PAT: 'knot_invalid' }),
          (err: unknown) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const e = err as { code?: number; stderr?: string };
            assert.notEqual(e.code, 0);
            assert.match(e.stderr ?? '', /401/);
            return true;
          },
        );
      });
    } finally {
      try {
        if (home !== undefined) rmSync(home, { recursive: true, force: true });
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
  },
);
