import type { Hono } from 'hono';
import type { ApiEnv } from '../server/http.ts';
import { parseAccessConfig } from './access.ts';
import { D1Storage } from '../storage/d1.ts';
import { createCloudflareApp } from './app.ts';

type RuntimeState = { serializedConfig: string; db: D1Database; app: Hono<ApiEnv> };

let state: RuntimeState | undefined;

function application(serializedConfig: string, db: D1Database): Hono<ApiEnv> {
  if (state?.serializedConfig === serializedConfig && state.db === db) return state.app;
  const app = createCloudflareApp(
    {
      storage: new D1Storage(db),
      config: { allowedImageHosts: [], allowedMediaHosts: [], allowedFrameHosts: [] },
    },
    parseAccessConfig(serializedConfig),
  );
  state = { serializedConfig, db, app };
  return app;
}

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    let app: Hono<ApiEnv>;
    try {
      app = application(env.KNOT_ACCESS_CONFIG, env.DB);
    } catch {
      return Response.json({ error: 'worker_configuration_invalid' }, { status: 503 });
    }
    return app.fetch(request, env, executionContext);
  },
} satisfies ExportedHandler<Env>;
