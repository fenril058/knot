import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../../src/server/ratelimit.ts';

test('limit 回までは許可、超過は拒否、窓が過ぎればまた許可', () => {
  const rl = new RateLimiter(3, 600);
  assert.equal(rl.allow('k', 1000), true);
  assert.equal(rl.allow('k', 1001), true);
  assert.equal(rl.allow('k', 1002), true);
  assert.equal(rl.allow('k', 1003), false);
  assert.equal(rl.allow('other', 1003), true);
  assert.equal(rl.allow('k', 1000 + 601), true);
});
