import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { createApplication } from '../../src/server/application.ts';
import { createAccessAuthenticationAdapter, type AccessConfig } from '../../src/worker/access.ts';
import { createCloudflareApp } from '../../src/worker/app.ts';
import { makeStorage } from '../helpers/storage.ts';

const access: AccessConfig = {
  issuer: 'https://knot-test.cloudflareaccess.com',
  audience: 'test-audience',
  email: 'owner@example.com',
  accountId: 'account-1',
  actorId: 'actor-2',
};
const now = Math.floor(Date.now() / 1000);
const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const key: JWTVerifyGetKey = async () => keys.publicKey;

type TokenOptions = {
  issuer?: string;
  audience?: string;
  email?: string;
  expiration?: number;
  privateKey?: CryptoKey;
};

function token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: options.email ?? access.email })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? access.issuer)
    .setAudience(options.audience ?? access.audience)
    .setIssuedAt(now)
    .setExpirationTime(options.expiration ?? now + 300)
    .sign(options.privateKey ?? keys.privateKey);
}

function authenticationApp() {
  const app = createApplication(
    { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] },
    createAccessAuthenticationAdapter(access, key),
  );
  app.get('/context', (c) => c.json({ accountId: c.get('accountId'), actorId: c.get('actorId') }));
  return app;
}

void test('valid Access identity を設定済み Account / Actor に解決する', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accountId: 'account-1', actorId: 'actor-2' });
});

void test('既存 project/page route は解決済み Account / Actor context を使う', async () => {
  const { storage } = makeStorage();
  const applicationNow = 1_700_000_000;
  await storage.addAccount({
    id: access.accountId,
    actor: { id: access.actorId, name: 'owner', displayName: 'Owner' },
    name: 'owner',
    email: access.email,
    passwordHash: 'not-used-by-worker',
    isAdmin: true,
  }, applicationNow);
  const project = await storage.ensureProject('project', applicationNow);
  const app = createCloudflareApp(
    {
      storage,
      config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] },
      now: () => applicationNow,
    },
    access,
    key,
  );
  const accessToken = await token();

  const write = await app.request('/api/knot/pages/project/Page/text', {
    method: 'PUT',
    headers: {
      'Cf-Access-Jwt-Assertion': accessToken,
      'Content-Type': 'application/json',
      'X-Knot-Client': 'test',
    },
    body: JSON.stringify({ baseVersion: 0, text: 'Page\nbody' }),
  });
  assert.equal(write.status, 200);
  const page = await storage.getPageByTitle(project.id, 'page');
  assert.ok(page);
  const authors = await storage.getPageAuthors(page.id);
  assert.equal(authors.lastUpdateUser?.id, access.actorId);

  const read = await app.request('/project/Page', {
    headers: { 'Cf-Access-Jwt-Assertion': accessToken },
  });
  assert.equal(read.status, 200);
  assert.notEqual(await storage.getVisit(access.accountId, page.id), null);
});

void test('Access JWT がない request と client-supplied identity header は fail closed', async () => {
  const app = authenticationApp();
  const missing = await app.request('/context');
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: 'unauthorized' });

  const spoofed = await app.request('/context', {
    headers: {
      'Cf-Access-Authenticated-User-Email': access.email,
      'X-Knot-Account-Id': access.accountId,
      'X-Knot-Actor-Id': access.actorId,
    },
  });
  assert.equal(spoofed.status, 401);
});

void test('Access JWT の signature failure は 401', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token({ privateKey: otherKeys.privateKey }) },
  });
  assert.equal(response.status, 401);
});

void test('Access JWT の issuer failure は 401', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token({ issuer: 'https://other.cloudflareaccess.com' }) },
  });
  assert.equal(response.status, 401);
});

void test('Access JWT の audience failure は 401', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token({ audience: 'wrong-audience' }) },
  });
  assert.equal(response.status, 401);
});

void test('Access JWT の expiry failure は 401', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token({ expiration: now - 1 }) },
  });
  assert.equal(response.status, 401);
});

void test('検証済みでも設定と異なる Access email は 403', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'Cf-Access-Jwt-Assertion': await token({ email: 'someone-else@example.com' }) },
  });
  assert.equal(response.status, 403);
});

void test('Worker application は password session endpoint と login page を公開しない', async () => {
  const { storage } = makeStorage();
  await storage.addAccount({
    id: access.accountId,
    actor: { id: access.actorId, name: 'owner', displayName: 'Owner' },
    name: 'owner',
    email: access.email,
    passwordHash: 'not-used-by-worker',
    isAdmin: true,
  }, now);
  const app = createCloudflareApp(
    { storage, config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] } },
    access,
    key,
  );
  const response = await app.request('/api/knot/session', {
    method: 'POST',
    headers: {
      'Cf-Access-Jwt-Assertion': await token(),
      'Content-Type': 'application/json',
      'X-Knot-Client': 'test',
    },
    body: JSON.stringify({ name: 'owner', password: 'password' }),
  });
  assert.equal(response.status, 404);

  const loginPage = await app.request('/login', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  });
  assert.equal(loginPage.status, 404);
  assert.doesNotMatch(await loginPage.text(), /type=["']password["']/i);
});

void test('Access 設定の Account / Actor mapping が storage に無ければ fail closed', async () => {
  const { storage } = makeStorage();
  const app = createCloudflareApp(
    { storage, config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] } },
    access,
    key,
  );
  const response = await app.request('/', {
    headers: { 'Cf-Access-Jwt-Assertion': await token() },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'identity_mapping_unavailable' });
});

void test('Worker application では PAT だけで Access boundary を迂回できない', async () => {
  const response = await authenticationApp().request('/context', {
    headers: { 'X-Personal-Access-Token': 'knot_client_value' },
  });
  assert.equal(response.status, 401);
});
