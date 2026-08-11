import type { Context, Hono } from 'hono';
import { parsePageSyntax } from '../../core/syntax.ts';
import { parseSearchQuery } from '../../core/searchQuery.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, resolvePage, resolveProject, safeDecode, type ApiEnv } from '../http.ts';
import { titleLc } from '../../core/title.ts';
import type { PageSummary, PageSort, RelatedPage } from '../../storage/types.ts';

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
    version: p.version, // knot 拡張: 同期 CLI 用
  };
}

function relatedToJson(p: RelatedPage) {
  return {
    id: p.id,
    title: p.title,
    titleLc: p.titleLc,
    image: p.image,
    descriptions: p.descriptions,
    linksLc: p.linksLc,
    linked: p.linked,
    updated: p.updated,
    accessed: p.updated,
  };
}

export function registerReadRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;

  const getPage = async (c: Context<ApiEnv>): Promise<Response> => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const authors = await storage.getPageAuthors(page.id);
    const related = await storage.getRelatedPages(project.id, page.id, page.titleLc);
    const titles = await storage.listPageTitles(project.id);
    const links = titles.find((t) => t.id === page.id)?.links ?? [];
    const descriptions = page.lines
      .slice(1)
      .filter((l) => l.text !== '')
      .slice(0, 5)
      .map((l) => l.text);
    return c.json({
      id: page.id,
      title: page.title,
      image: page.image,
      descriptions,
      pin: page.pinned,
      views: 0,
      linked: related.linked,
      created: page.created,
      updated: page.updated,
      user: authors.user ?? authors.lastUpdateUser,
      lastUpdateUser: authors.lastUpdateUser,
      accessed: page.updated,
      version: page.version,
      persistent: true,
      lines: page.lines.map((l) => ({
        id: l.id,
        text: l.text,
        userId: l.userId,
        created: l.created,
        updated: l.updated,
      })),
      links,
      relatedPages: {
        links1hop: related.links1hop.map(relatedToJson),
        links2hop: related.links2hop.map(relatedToJson),
        hasBackLinksOrIcons: related.hasBackLinks,
      },
      collaborators: [],
      lastAccessed: page.updated,
    });
  };

  const listPages = async (c: Context<ApiEnv>): Promise<Response> => {
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const sort = (SORTS.has(sortRaw) ? sortRaw : 'updated') as PageSort;
    const limit = Math.min(limitRaw, 1000);
    const { count, pages } = await storage.listPageSummaries(project.id, { skip, limit, sort });
    return c.json({ projectName: project.name, skip, limit, count, pages: pages.map(summaryToJson) });
  };

  app.get('/api/pages/:project', listPages);
  // 公式 cosense-cli の listPages は末尾スラッシュ付き URL を構築するため、両方を受ける
  app.get('/api/pages/:project/', listPages);

  app.get('/api/pages/:project/search/titles', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    return c.json(await storage.listPageTitles(project.id));
  });

  app.get('/api/pages/:project/search/query', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const q = c.req.query('q');
    if (q === undefined || q.trim() === '') {
      return jsonError(c, 400, 'bad_request', { message: 'q required' });
    }
    const query = parseSearchQuery(q);
    const hits = await storage.search(project.id, query);
    return c.json({
      projectName: project.name,
      searchQuery: q,
      query,
      limit: 100,
      count: hits.length,
      existsExactTitleMatch: hits.some((hit) => titleLc(hit.title) === titleLc(q)),
      pages: hits.slice(0, 100).map((hit) => ({
        id: hit.pageId,
        title: hit.title,
        image: hit.image,
        words: query.words,
        lines: hit.lines,
      })),
    });
  });

  app.get('/api/projects/:project/users', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const users = await storage.listUsersForProject(project.id);
    return c.json({ projectName: project.name, users });
  });

  app.get('/api/code/:project/:title/:filename', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const page = await resolvePage(storage, project.id, c);
    if (!page) return jsonError(c, 404, 'not_found');
    const filename = safeDecode(c.req.param('filename'));
    if (filename === null) return jsonError(c, 404, 'not_found');
    const blocks = parsePageSyntax(page.lines.map((line) => line.text).join('\n'), { hasTitle: true });
    const contents: string[] = [];
    for (const block of blocks) {
      if (block.type === 'codeBlock' && block.fileName === filename) contents.push(block.content);
    }
    if (contents.length === 0) return jsonError(c, 404, 'not_found');
    return c.text(contents.join('\n'));
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

  app.get('/api/pages/v2/:project/:title', getPage);
  app.get('/api/pages/:project/:title', getPage);
}
