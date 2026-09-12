import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareWorkerAssets } from '../../scripts/prepare-worker-assets.ts';

void test('CSS と browser script を Workers Static Assets の /assets/ 配下に配置する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'knot-worker-assets-'));
  const source = join(directory, 'public');
  const destination = join(directory, 'output');
  try {
    await mkdir(join(source, 'build'), { recursive: true });
    await writeFile(join(source, 'app.css'), 'body { color: teal; }\n');
    await writeFile(join(source, 'build', 'editor.js'), 'export const editor = true;\n');

    await prepareWorkerAssets(source, destination);

    assert.equal(await readFile(join(destination, 'assets', 'app.css'), 'utf8'), 'body { color: teal; }\n');
    assert.equal(
      await readFile(join(destination, 'assets', 'build', 'editor.js'), 'utf8'),
      'export const editor = true;\n',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
