import type { Hono } from 'hono';
import type { AppDeps } from '../app.ts';
import { jsonError, resolvePage, resolveProject, type ApiEnv } from '../http.ts';
import type { PageSummary, PageSort } from '../../storage/types.ts';

const SORTS = new Set<string>(['updated', 'created', 'linked', 'title']);
const FALLBACK_SORTS = new Set<string>(['accessed', 'views']);

function summaryToJson(p: PageSummary) {
  return {
    id: p.id,
    title: p.title,
    image: p.image,
    descriptions: p.descriptions,
    pin: p.pinned,
    views: 0,
    linked: p.linked,
    created: p.created,
    updated: p.updated,
    accessed: p.updated,
  };
}

export function registerReadRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;

  app.get('/api/pages/:project', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const skip = Number(c.req.query('skip') ?? '0');
    const limitRaw = Number(c.req.query('limit') ?? '100');
    const sortRaw = c.req.query('sort') ?? 'updated';
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limitRaw) || limitRaw < 1) {
      return jsonError(c, 400, 'bad_request', { message: 'invalid skip/limit' });
    }
    if (!SORTS.has(sortRaw) && !FALLBACK_SORTS.has(sortRaw)) {
      return jsonError(c, 400, 'bad_request', { message: `invalid sort: ${sortRaw}` });
    }
    const sort = (SORTS.has(sortRaw) ? sortRaw : 'updated') as PageSort;
    const limit = Math.min(limitRaw, 1000);
    const { count, pages } = await storage.listPageSummaries(project.id, { skip, limit, sort });
    return c.json({ projectName: project.name, skip, limit, count, pages: pages.map(summaryToJson) });
  });

  app.get('/api/pages/:project/:title/text', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    return c.text(page.lines.map((l) => l.text).join('\n'));
  });

  app.get('/api/pages/:project/:title/icon', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page || page.image === null) return jsonError(c, 404, 'not_found');
    return c.redirect(page.image, 302);
  });
}
