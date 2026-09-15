import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTestHarness } from 'wrangler';

const accessConfig = JSON.stringify({
  issuer: 'https://knot-test.cloudflareaccess.com',
  audience: 'test-audience',
  email: 'owner@example.com',
  accountId: 'test-account',
  actorId: 'test-actor',
});

function compatibilityDate(config: string): string {
  const match = /"compatibility_date"\s*:\s*"([^"]+)"/u.exec(config);
  assert.ok(match?.[1]);
  return match[1];
}

void test('Wrangler production build は CSS と browser script を Static Assets router から配信する', async () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: './wrangler.jsonc',
        prebuiltWorkerDir: './dist/worker',
        secrets: { KNOT_ACCESS_CONFIG: accessConfig },
      },
    ],
  });

  try {
    await server.listen();

    const css = await server.fetch('/assets/app.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /^text\/css(?:;|$)/);
    assert.equal(await css.text(), await readFile('.worker-assets/assets/app.css', 'utf8'));

    const script = await server.fetch('/assets/build/editor.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /^(?:application|text)\/javascript(?:;|$)/);
    assert.equal(await script.text(), await readFile('.worker-assets/assets/build/editor.js', 'utf8'));

    const dynamic = await server.fetch('/api/pages/test-project');
    assert.equal(dynamic.status, 401);
    assert.deepEqual(await dynamic.json(), { error: 'unauthorized' });
  } finally {
    await server.close();
  }
});

void test('configured workerd runtime supports the node:crypto operation hash', async () => {
  const [productionConfig, fixtureConfig] = await Promise.all([
    readFile('wrangler.jsonc', 'utf8'),
    readFile('test/worker/fixtures/ops-hash.wrangler.jsonc', 'utf8'),
  ]);
  assert.equal(compatibilityDate(fixtureConfig), compatibilityDate(productionConfig));
  const server = createTestHarness({
    workers: [{ configPath: './test/worker/fixtures/ops-hash.wrangler.jsonc' }],
  });

  try {
    await server.listen();
    const response = await server.fetch('/');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      digest: 'bf3bb29ff1933e760a51bdd26275d77d283cda0ca9b208e34e56052be71c90a4',
      runtime: 'workerd',
    });
  } finally {
    await server.close();
  }
});
