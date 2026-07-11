import { test } from 'node:test';
import assert from 'node:assert/strict';

test('toolchain runs TypeScript tests', () => {
  const x: number = 1 + 1;
  assert.equal(x, 2);
});
