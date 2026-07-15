import type { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import type { ApiEnv } from '../http.ts';
import { loginPage } from '../views/login.ts';
import { pageListPage } from '../views/pageList.ts';

export function registerPageRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  app.get('/login', (c) => c.html(loginPage()));

  app.get('/:project', async (c) => {
    const project = await deps.storage.getProject(c.req.param('project'));
    if (project === null) return c.notFound();

    const skip = Number(c.req.query('skip') ?? '0');
    const limit = Number(c.req.query('limit') ?? '30');
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      return c.text('bad request', 400);
    }

    const result = await deps.storage.listPageSummaries(project.id, {
      skip,
      limit,
      sort: 'updated',
      pinnedFirst: true,
    });
    return c.html(pageListPage(project, result, skip, limit));
  });
}
