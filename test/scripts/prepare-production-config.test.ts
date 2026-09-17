import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

void test('production config rejects a route from the tracked config before creating a deployment config', () => {
  const root = mkdtempSync(join(tmpdir(), 'knot-production-config-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../../scripts/prepare-production-config.ts', import.meta.url), join(root, 'scripts/prepare-production-config.ts'));
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ routes: [{ pattern: 'example.com/*', zone_name: 'example.com' }] }));
    const result = spawnSync(process.execPath, [join(root, 'scripts/prepare-production-config.ts')], {
      env: { ...process.env, KNOT_D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public route/u);
    assert.equal(existsSync(join(root, '.wrangler.production.jsonc')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
