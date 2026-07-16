import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { renderLines } from '../../render/render.ts';
import type { AppDeps } from '../app.ts';
import { resolvePage, resolveProject, safeDecode, type ApiEnv } from '../http.ts';
import { loginPage } from '../views/login.ts';
import { pageListPage } from '../views/pageList.ts';
import { pageNotFoundPage, pageViewPage, projectNotFoundPage } from '../views/pageView.ts';
import { projectIndexPage } from '../views/projectIndex.ts';
import { editorPage } from '../views/editor.ts';

export function registerPageRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  app.get('/login', (c) => c.html(loginPage()));

  app.get('/', async (c) => c.html(projectIndexPage(await deps.storage.listProjects())));

  app.get('/:project', async (c) => {
    const project = await deps.storage.getProject(c.req.param('project'));
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);

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
    return c.html(pageListPage(project, result, skip, limit, deps.config.allowedImageHosts));
  });

  app.get('/:project/:title/edit', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);

    const rawTitle = safeDecode(c.req.param('title')) ?? c.req.param('title');
    const page = await resolvePage(deps.storage, project.id, c);
    const userId = c.get('userId');
    const user = await deps.storage.getUserById(userId);
    const previousVisit = page === null ? null : await deps.storage.getVisit(userId, page.id);
    if (page !== null) {
      const isCrossSite = c.req.header('Sec-Fetch-Site')?.toLowerCase() === 'cross-site';
      const isPrefetch = c.req.header('Sec-Purpose')?.toLowerCase().includes('prefetch') === true;
      if (!isCrossSite && !isPrefetch) {
        await deps.storage.recordVisit(userId, page.id, now(), page.version);
      }
    }
    const styleNonce = randomBytes(16).toString('base64');
    c.set('styleNonce', styleNonce);
    return c.html(editorPage(project, page?.title ?? rawTitle, user?.name ?? '', previousVisit, styleNonce));
  });

  app.get('/:project/:title', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);

    const page = await resolvePage(deps.storage, project.id, c);
    if (page === null) {
      const rawTitle = safeDecode(c.req.param('title')) ?? c.req.param('title');
      c.status(404);
      return c.html(pageNotFoundPage(project, rawTitle));
    }

    const userId = c.get('userId');
    const previousVisit = await deps.storage.getVisit(userId, page.id);
    const related = await deps.storage.getRelatedPages(project.id, page.id, page.titleLc);
    const titles = await deps.storage.listKnownPages(project.id);
    const knownPages = new Map(titles.map((entry) => [entry.titleLc, { title: entry.title, image: entry.image }]));
    const rendered = renderLines(page.lines, knownPages, project.name, {
      allowedImageHosts: deps.config.allowedImageHosts,
      allowedMediaHosts: deps.config.allowedMediaHosts,
    });
    const isCrossSite = c.req.header('Sec-Fetch-Site')?.toLowerCase() === 'cross-site';
    const isPrefetch = c.req.header('Sec-Purpose')?.toLowerCase().includes('prefetch') === true;
    if (!isCrossSite && !isPrefetch) {
      await deps.storage.recordVisit(userId, page.id, now(), page.version);
    }
    return c.html(pageViewPage(project, page, rendered, previousVisit, related));
  });
}
