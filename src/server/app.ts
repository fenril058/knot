import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Storage } from '../storage/types.ts';
import type { ServerConfig } from './config.ts';
import { clientIp, jsonError, type ApiEnv } from './http.ts';
import { verifyPassword } from './password.ts';
import { hashApiToken } from './apiToken.ts';
import { RateLimiter } from './ratelimit.ts';
import { registerReadRoutes } from './routes/read.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerWriteRoutes } from './routes/write.ts';
import { registerPageRoutes } from './routes/pages.ts';

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

const hosts = (list: string[]): string => (list.length === 0 ? '' : ` ${list.join(' ')}`);

function cspValue(config: ServerConfig): string {
  const frame = config.allowedFrameHosts.length === 0 ? "'none'" : config.allowedFrameHosts.join(' ');
  return [
    "default-src 'self'",
    `img-src 'self'${hosts(config.allowedImageHosts)}`,
    `media-src 'self'${hosts(config.allowedMediaHosts)}`,
    `frame-src ${frame}`,
  ].join('; ');
}

export function createApp(deps: AppDeps): Hono<ApiEnv> {
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const loginLimiter = new RateLimiter(10, 10 * 60);
  const csp = cspValue(config);
  const app = new Hono<ApiEnv>();

  const setSessionCookie = (c: Context<ApiEnv>, id: string): void => {
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.secureCookie !== false,
      path: '/',
      maxAge: config.sessionTtlSeconds,
    });
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    const styleNonce = c.get('styleNonce');
    c.header(
      'Content-Security-Policy',
      styleNonce === undefined ? csp : `${csp}; style-src 'self' 'nonce-${styleNonce}'`,
    );
  });

  app.use('/api/knot/*', async (c, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(c.req.method) && !c.req.header('X-Knot-Client')) {
      return jsonError(c, 403, 'forbidden', { message: 'X-Knot-Client header required' });
    }
    return next();
  });

  app.use('*', async (c, next) => {
    const requestClass = classifyRequest(c.req.method, c.req.path);
    if (requestClass === 'public') return next();
    const apiToken = requestClass === 'api' ? c.req.header('x-personal-access-token') : undefined;
    if (apiToken !== undefined) {
      const user = await storage.getUserByApiTokenHash(hashApiToken(apiToken));
      if (user === null) return jsonError(c, 401, 'unauthorized');
      c.set('userId', user.id);
      return next();
    }
    const sid = getCookie(c, SESSION_COOKIE);
    const session = sid === undefined ? null : await storage.getSession(sid, now());
    if (session === null) {
      if (requestClass === 'api') return jsonError(c, 401, 'unauthorized');
      const requestUrl = new URL(c.req.url);
      const nextPath = `${requestUrl.pathname}${requestUrl.search}`;
      return c.redirect(`/login?next=${encodeURIComponent(nextPath)}`, 302);
    }
    if (session.expires - now() < config.sessionTtlSeconds - REFRESH_MARGIN_SECONDS) {
      await storage.refreshSession(session.id, now() + config.sessionTtlSeconds);
      setSessionCookie(c, session.id);
    }
    c.set('userId', session.userId);
    return next();
  });

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
    const user = await storage.getUserByName(body.name);
    if (!user || user.passwordHash === null || !verifyPassword(body.password, user.passwordHash)) {
      return jsonError(c, 401, 'invalid_credentials');
    }
    const session = {
      id: randomBytes(16).toString('hex'),
      userId: user.id,
      expires: now() + config.sessionTtlSeconds,
      created: now(),
    };
    await storage.createSession(session);
    setSessionCookie(c, session.id);
    return c.json({ id: user.id, name: user.name, displayName: user.displayName, isAdmin: user.isAdmin });
  });

  app.delete('/api/knot/session', async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid !== undefined) await storage.deleteSession(sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  registerReadRoutes(app, deps);
  registerWriteRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerPageRoutes(app, deps);

  return app;
}
