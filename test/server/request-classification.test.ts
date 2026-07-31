import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest } from '../../src/server/app.ts';

void test('classifyRequest は既存の認証区分を宣言的に分類する', () => {
  const cases = [
    ['POST', '/api/knot/session', 'public'],
    ['GET', '/api/knot/session', 'api'],
    ['GET', '/login', 'public'],
    ['POST', '/login', 'public'],
    ['GET', '/assets/app.css', 'public'],
    ['GET', '/assets', 'html'],
    ['GET', '/api/knot/projects', 'api'],
    ['GET', '/files/attachment', 'api'],
    ['GET', '/', 'html'],
    ['GET', '/proj/Page', 'html'],
  ] as const;

  for (const [method, path, expected] of cases) {
    assert.equal(classifyRequest(method, path), expected, `${method} ${path}`);
  }
});
