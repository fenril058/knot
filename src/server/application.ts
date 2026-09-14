import { Hono, type Context } from 'hono';
import { UnsupportedStorageOperationError, type Storage } from '../storage/types.ts';
import { jsonError, type ApiEnv } from './http.ts';
import { registerReadRoutes } from './routes/read.ts';
import { registerWriteRoutes } from './routes/write.ts';
import { registerPageRoutes } from './routes/pages.ts';

export type ApplicationConfig = {
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
  allowedFrameHosts: string[];
};

export type ApplicationDeps = {
  storage: Storage;
  config: ApplicationConfig;
  now?: () => number;
};

type AuthenticationResult =
  | { kind: 'authenticated'; accountId: string; actorId: string }
  | { kind: 'public' }
  | { kind: 'response'; response: Response };

export type AuthenticationAdapter = (c: Context<ApiEnv>) => Promise<AuthenticationResult>;

const hosts = (list: string[]): string => (list.length === 0 ? '' : ` ${list.join(' ')}`);

function cspValue(config: ApplicationConfig): string {
  const frame = config.allowedFrameHosts.length === 0 ? "'none'" : config.allowedFrameHosts.join(' ');
  return [
    "default-src 'self'",
    `img-src 'self'${hosts(config.allowedImageHosts)}`,
    `media-src 'self'${hosts(config.allowedMediaHosts)}`,
    `frame-src ${frame}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createApplication(config: ApplicationConfig, authenticate: AuthenticationAdapter): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const csp = cspValue(config);

  app.onError((error, c) => {
    if (error instanceof UnsupportedStorageOperationError) {
      return jsonError(c, 501, 'storage_operation_unavailable', { message: error.message });
    }
    throw error;
  });

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
    const result = await authenticate(c);
    if (result.kind === 'public') return next();
    if (result.kind === 'response') return result.response;
    c.set('accountId', result.accountId);
    c.set('actorId', result.actorId);
    return next();
  });

  return app;
}

export function registerPortableApiRoutes(app: Hono<ApiEnv>, deps: ApplicationDeps): void {
  registerReadRoutes(app, deps);
  registerWriteRoutes(app, deps);
}

export function registerPortablePageRoutes(app: Hono<ApiEnv>, deps: ApplicationDeps): void {
  registerPageRoutes(app, deps);
}
