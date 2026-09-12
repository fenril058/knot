import type { JWTVerifyGetKey } from 'jose';
import type { Storage } from '../storage/types.ts';
import {
  createApplication,
  registerPortableApiRoutes,
  registerPortablePageRoutes,
  type ApplicationConfig,
} from '../server/application.ts';
import { jsonError } from '../server/http.ts';
import { createAccessAuthenticationAdapter, type AccessConfig } from './access.ts';

export type CloudflareAppDeps = {
  storage: Storage;
  config: ApplicationConfig;
  now?: () => number;
};

export function createCloudflareApp(
  deps: CloudflareAppDeps,
  access: AccessConfig,
  key?: JWTVerifyGetKey,
) {
  const app = createApplication(deps.config, createAccessAuthenticationAdapter(access, key));
  registerPortableApiRoutes(app, deps);
  registerPortablePageRoutes(app, deps);
  return app;
}

export function createCloudflareBoundary(access: AccessConfig, key?: JWTVerifyGetKey) {
  const app = createApplication(
    { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] },
    createAccessAuthenticationAdapter(access, key),
  );
  app.all('*', (c) => jsonError(c, 503, 'storage_unavailable', { message: 'D1 storage is not configured' }));
  return app;
}
