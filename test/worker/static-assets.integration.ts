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
