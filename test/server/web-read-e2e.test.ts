import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('login → 一覧 → 閲覧 → 再訪問 → 404 の一気通貫でインライン要素を含まない', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['content'], s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['links to [Beta] and [Ghost]'], s.clock.t + 1);

  const htmlBodies: string[] = [];

  const unauthenticated = await s.request('/proj');
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get('location'), '/login?next=%2Fproj');

  const loginPage = await s.request('/login');
  assert.equal(loginPage.status, 200);
  htmlBodies.push(await loginPage.text());

  const cookie = await s.login('alice', 'pw12345678');

  const pageList = await s.request('/proj', {}, cookie);
  assert.equal(pageList.status, 200);
  htmlBodies.push(await pageList.text());

  const firstVisit = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(firstVisit.status, 200);
  const firstVisitBody = await firstVisit.text();
  assert.match(firstVisitBody, /href="\/proj\/Beta"[^>]*>Beta</);
  assert.match(firstVisitBody, /class="empty-link"[^>]*>Ghost</);
  assert.match(firstVisitBody, /class="telomere unread\b/);
  htmlBodies.push(firstVisitBody);

  const secondVisit = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(secondVisit.status, 200);
  const secondVisitBody = await secondVisit.text();
  assert.doesNotMatch(secondVisitBody, /class="telomere unread\b/);
  htmlBodies.push(secondVisitBody);

  const notFound = await s.request('/proj/Nope', {}, cookie);
  assert.equal(notFound.status, 404);
  const notFoundBody = await notFound.text();
  assert.match(notFoundBody, /Nope/);
  assert.match(notFoundBody, /href="\/proj\/Nope\/edit"/);
  htmlBodies.push(notFoundBody);

  for (const body of htmlBodies) {
    assert.doesNotMatch(body, /<script>/i);
    assert.doesNotMatch(body, /<style(?:\s|>)/i);
    assert.doesNotMatch(body, / on[a-z]+="/i);
  }
});
