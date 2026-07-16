import type { Hono } from 'hono';
import { titleLc } from '../../core/title.ts';
import { renderLines } from '../../render/render.ts';
import type { AppDeps } from '../app.ts';
import { resolvePage, resolveProject, safeDecode, type ApiEnv } from '../http.ts';
import { loginPage } from '../views/login.ts';
import { pageListPage } from '../views/pageList.ts';
import { pageNotFoundPage, pageViewPage } from '../views/pageView.ts';

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

  app.get('/:project/:title', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.notFound();

    const page = await resolvePage(deps.storage, project.id, c);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
    if (page === null) {
      const rawTitle = safeDecode(c.req.param('title')) ?? c.req.param('title');
      c.status(404);
      return c.html(pageNotFoundPage(project, rawTitle));
    }

    const userId = c.get('userId');
    const previousVisit = await deps.storage.getVisit(userId, page.id);
    const related = await deps.storage.getRelatedPages(project.id, page.id, page.titleLc);
    const titles = await deps.storage.listPageTitles(project.id);
    const knownPages = new Map(titles.map((entry) => [titleLc(entry.title), { title: entry.title, image: entry.image }]));
    const rendered = renderLines(page.lines, knownPages, project.name, {
      allowedImageHosts: deps.config.allowedImageHosts,
      allowedMediaHosts: deps.config.allowedMediaHosts,
    });
    await deps.storage.recordVisit(userId, page.id, now, page.version);
    return c.html(pageViewPage(project, page, rendered, previousVisit, related));
  });
}
