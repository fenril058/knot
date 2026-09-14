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
  const accessAuthentication = createAccessAuthenticationAdapter(access, key);
  const app = createApplication(deps.config, async (c) => {
    const result = await accessAuthentication(c);
    if (result.kind !== 'authenticated') return result;
    const [account, actor] = await Promise.all([
      deps.storage.getAccountById(result.accountId),
      deps.storage.getActorById(result.actorId),
    ]);
    if (account === null || actor === null || account.actorId !== actor.id) {
      return { kind: 'response', response: jsonError(c, 503, 'identity_mapping_unavailable') };
    }
    return result;
  });
  registerPortableApiRoutes(app, deps);
  registerPortablePageRoutes(app, deps);
  return app;
}
