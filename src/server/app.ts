import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Storage } from '../storage/types.ts';
import type { ServerConfig } from './config.ts';
import { clientIp, jsonError, type ApiEnv } from './http.ts';
import { verifyPassword } from './password.ts';
import { RateLimiter } from './ratelimit.ts';
import { registerReadRoutes } from './routes/read.ts';
import { registerFileRoutes } from './routes/files.ts';
import { registerWriteRoutes } from './routes/write.ts';
import { registerPageRoutes } from './routes/pages.ts';

export type AppDeps = { storage: Storage; config: ServerConfig; now?: () => number };

const SESSION_COOKIE = 'connect.sid';
const REFRESH_MARGIN_SECONDS = 24 * 60 * 60;

function cspValue(config: ServerConfig): string {
  const hosts = (list: string[]): string => (list.length === 0 ? '' : ` ${list.join(' ')}`);
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
    c.header('Content-Security-Policy', csp);
  });

  app.use('/api/knot/*', async (c, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(c.req.method) && !c.req.header('X-Knot-Client')) {
      return jsonError(c, 403, 'forbidden', { message: 'X-Knot-Client header required' });
    }
    return next();
  });

  const PUBLIC_PATHS = new Set(['/login']);

  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === '/api/knot/session') return next();
    if (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith('/assets/')) return next();
    const sid = getCookie(c, SESSION_COOKIE);
    const session = sid === undefined ? null : await storage.getSession(sid, now());
    if (session === null) {
      const isApiOrFiles = c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/');
      if (isApiOrFiles) return jsonError(c, 401, 'unauthorized');
      const requestUrl = new URL(c.req.url);
      const next = `${requestUrl.pathname}${requestUrl.search}`;
      return c.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    }
    if (session.expires - now() < config.sessionTtlSeconds - REFRESH_MARGIN_SECONDS) {
      await storage.refreshSession(session.id, now() + config.sessionTtlSeconds);
      setSessionCookie(c, session.id);
    }
    c.set('userId', session.userId);
    return next();
  });

  app.use('/assets/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/assets/, '') }));

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
