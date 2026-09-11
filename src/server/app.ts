import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Storage } from '../storage/types.ts';
import {
  createApplication,
  registerPortableApiRoutes,
  registerPortablePageRoutes,
  type AuthenticationAdapter,
} from './application.ts';
import type { ServerConfig } from './config.ts';
import { clientIp, jsonError, type ApiEnv } from './http.ts';
import { verifyPassword } from './password.ts';
import { hashApiToken } from './apiToken.ts';
import { RateLimiter } from './ratelimit.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerProjectTransferRoutes } from './routes/projectTransfer.ts';
import { loginPage } from './views/login.ts';

export type AppDeps = { storage: Storage; config: ServerConfig; now?: () => number; fetchFn?: typeof fetch };

const SESSION_COOKIE = 'connect.sid';
const REFRESH_MARGIN_SECONDS = 24 * 60 * 60;
const PUBLIC_PATHS = new Set(['/login']);

export type RequestClass = 'public' | 'api' | 'html';

export function classifyRequest(method: string, path: string): RequestClass {
  if (method === 'POST' && path === '/api/knot/session') return 'public';
  if (PUBLIC_PATHS.has(path) || path.startsWith('/assets/')) return 'public';
  if (path.startsWith('/api/') || path.startsWith('/files/')) return 'api';
  return 'html';
}

export function publicDirectory(): string {
  return fileURLToPath(new URL('../../public/', import.meta.url));
}

export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const loginLimiter = new RateLimiter(10, 10 * 60);

  const setSessionCookie = (c: Context<ApiEnv>, id: string): void => {
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.secureCookie !== false,
      path: '/',
      maxAge: config.sessionTtlSeconds,
    });
  };

  const authenticate: AuthenticationAdapter = async (c) => {
    const requestClass = classifyRequest(c.req.method, c.req.path);
    if (requestClass === 'public') return { kind: 'public' };
    const apiToken = requestClass === 'api' ? c.req.header('x-personal-access-token') : undefined;
    if (apiToken !== undefined) {
      const account = await storage.getAccountByApiTokenHash(hashApiToken(apiToken));
      if (account === null) return { kind: 'response', response: jsonError(c, 401, 'unauthorized') };
      return { kind: 'authenticated', accountId: account.id, actorId: account.actorId };
    }
    const sid = getCookie(c, SESSION_COOKIE);
    const session = sid === undefined ? null : await storage.getSession(sid, now());
    if (session === null) {
      if (requestClass === 'api') {
        return { kind: 'response', response: jsonError(c, 401, 'unauthorized') };
      }
      const requestUrl = new URL(c.req.url);
      const nextPath = `${requestUrl.pathname}${requestUrl.search}`;
      return { kind: 'response', response: c.redirect(`/login?next=${encodeURIComponent(nextPath)}`, 302) };
    }
    if (session.expires - now() < config.sessionTtlSeconds - REFRESH_MARGIN_SECONDS) {
      await storage.refreshSession(session.id, now() + config.sessionTtlSeconds);
      setSessionCookie(c, session.id);
    }
    const account = await storage.getAccountById(session.accountId);
    if (account === null) return { kind: 'response', response: jsonError(c, 401, 'unauthorized') };
    return { kind: 'authenticated', accountId: account.id, actorId: account.actorId };
  };

  const app = createApplication(config, authenticate);

  app.use('/assets/*', serveStatic({ root: publicDirectory(), rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }));

  app.post('/api/knot/session', async (c) => {
    let body: { name?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    }
    if (typeof body.name !== 'string' || typeof body.password !== 'string') {
      return jsonError(c, 400, 'bad_request', { message: 'name and password required' });
    }
    if (!loginLimiter.allow(`${clientIp(c)}:${body.name}`, now())) {
      return jsonError(c, 429, 'too_many_attempts');
    }
    const account = await storage.getAccountByName(body.name);
    if (!account || account.passwordHash === null || !verifyPassword(body.password, account.passwordHash)) {
      return jsonError(c, 401, 'invalid_credentials');
    }
    const session = {
      id: randomBytes(16).toString('hex'),
      accountId: account.id,
      expires: now() + config.sessionTtlSeconds,
      created: now(),
    };
    await storage.createSession(session);
    setSessionCookie(c, session.id);
    const actor = await storage.getActorById(account.actorId);
    if (actor === null) throw new Error(`account ${account.id} has no actor`);
    return c.json({ id: account.id, name: account.name, displayName: actor.displayName, isAdmin: account.isAdmin });
  });

  app.delete('/api/knot/session', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid !== undefined) await storage.deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/login', (c) => c.html(loginPage()));

  registerPortableApiRoutes(app, deps);
  registerProjectTransferRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerPortablePageRoutes(app, deps);

  return app;
}
