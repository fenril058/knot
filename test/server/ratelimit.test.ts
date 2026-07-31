import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/server/ratelimit.ts';

void test('limit 回までは許可、超過は拒否、窓が過ぎればまた許可', () => {
  const rl = new RateLimiter(3, 600);
  assert.equal(rl.allow('k', 1000), true);
  assert.equal(rl.allow('k', 1001), true);
  assert.equal(rl.allow('k', 1002), true);
  assert.equal(rl.allow('k', 1003), false);
  assert.equal(rl.allow('other', 1003), true);
  assert.equal(rl.allow('k', 1000 + 601), true);
});

void test('多数の期限切れキーを sweep で解放する', () => {
  const rl = new RateLimiter(3, 600);
  for (let i = 0; i < 2000; i += 1) {
    assert.equal(rl.allow(`key-${i}`, 1000), true);
  }
  const sizeBeforeSweep = rl.size;

  assert.equal(rl.allow('new-key', 1601), true);
  assert.ok(rl.size < sizeBeforeSweep);
});
