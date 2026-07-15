import type { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { ApiEnv } from '../http.ts';
import { loginPage } from '../views/login.ts';

export function registerPageRoutes(app: Hono<ApiEnv>, _deps: AppDeps): void {
  app.get('/login', (c) => c.html(loginPage()));
}
