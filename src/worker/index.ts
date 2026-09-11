import type { Hono } from 'hono';
import type { ApiEnv } from '../server/http.ts';
import { parseAccessConfig } from './access.ts';
import { createCloudflareBoundary } from './app.ts';

type RuntimeState = { serializedConfig: string; app: Hono<ApiEnv> };

let state: RuntimeState | undefined;

function application(serializedConfig: string): Hono<ApiEnv> {
  if (state?.serializedConfig === serializedConfig) return state.app;
  const app = createCloudflareBoundary(parseAccessConfig(serializedConfig));
  state = { serializedConfig, app };
  return app;
}

export default {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    try {
      return await application(env.KNOT_ACCESS_CONFIG).fetch(request, env, executionContext);
    } catch {
      return Response.json({ error: 'worker_configuration_invalid' }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
