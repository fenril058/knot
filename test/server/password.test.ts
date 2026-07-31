import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/server/password.ts';

void test('ハッシュと検証が往復する', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

void test('同じパスワードでも salt でハッシュが変わる', () => {
  assert.notEqual(hashPassword('pw12345678'), hashPassword('pw12345678'));
});

void test('壊れた保存形式は false（例外にしない）', () => {
  assert.equal(verifyPassword('pw', 'not-a-hash'), false);
  assert.equal(verifyPassword('pw', 'scrypt:16384:8:1:AAAA'), false);
});

void test('許可しない scrypt パラメータは検証せず false（巨大な N による DoS 防止）', () => {
  const salt = 'A'.repeat(22); // 16 バイトの base64url
  const hash = 'A'.repeat(43); // 32 バイトの base64url
  assert.equal(verifyPassword('pw', `scrypt:1048576:8:1:${salt}:${hash}`), false);
  assert.equal(verifyPassword('pw', `scrypt:16384:8:1:${'A'.repeat(4)}:${hash}`), false); // salt 長不正
});
