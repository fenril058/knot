import type { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { checkSearchQuery } from '../../core/searchQuery.ts';
import { pageHref, titleLc } from '../../core/title.ts';
import { renderLines } from '../../render/render.ts';
import type { ApplicationDeps } from '../application.ts';
import { resolvePage, resolveProject, safeDecode, type ApiEnv } from '../http.ts';
import { isPageSort, pageListPage } from '../views/pageList.ts';
import { emptyPageView, linkedEmptyPages, pageViewPage, projectNotFoundPage } from '../views/pageView.ts';
import { projectIndexPage } from '../views/projectIndex.ts';
import { searchResultsPage } from '../views/searchPage.ts';

// プロジェクトのトップの並び替え（#291）。Cosense と同じく、選んだ並び替えをプロジェクトごとにブラウザへ残す。
// ページを開いた時から選んだ順で描けるよう、localStorage ではなく、そのプロジェクトの path の cookie に残す。
const PAGE_SORT_COOKIE = 'knot_page_sort';
const PAGE_SORT_MAX_AGE = 60 * 60 * 24 * 365;

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function registerPageRoutes(app: Hono<ApiEnv>, deps: ApplicationDeps): void {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  app.get('/', async (c) => c.html(projectIndexPage(await deps.storage.listProjects())));

  app.get('/:project', async (c) => {
    const project = await deps.storage.getProject(c.req.param('project'));
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);

    const skip = Number(c.req.query('skip') ?? '0');
    const limit = Number(c.req.query('limit') ?? '30');
    if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit <= 0 || limit > 200) {
      return c.text('bad request', 400);
    }

    const requested = c.req.query('sort');
    const stored = getCookie(c, PAGE_SORT_COOKIE);
    const sort = isPageSort(requested) ? requested : isPageSort(stored) ? stored : 'updated';
    if (isPageSort(requested)) {
      setCookie(c, PAGE_SORT_COOKIE, requested, {
        path: `/${encodeURIComponent(project.name)}`,
        httpOnly: true,
        sameSite: 'Lax',
        secure: new URL(c.req.url).protocol === 'https:',
        maxAge: PAGE_SORT_MAX_AGE,
      });
    }
    const result = await deps.storage.listPageSummaries(project.id, { skip, limit, sort, pinnedFirst: true });
    return c.html(pageListPage(project, result, skip, limit, sort, deps.config.allowedImageHosts));
  });

  // 全文検索の結果ページ（#247）。ページの URL（/:project/:title）とは段の数が違うので重ならない。
  app.get('/:project/search/page', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);
    const query = c.req.query('q') ?? '';
    const checked = checkSearchQuery(query);
    if (!checked.ok) {
      const result = { kind: 'problem', problem: checked.problem } as const;
      return c.html(searchResultsPage(project, query, result, deps.config.allowedImageHosts), checked.problem === 'required' ? 200 : 400);
    }
    const hits = await deps.storage.search(project.id, checked.query);
    const result = { kind: 'hits', words: checked.query.words, hits } as const;
    return c.html(searchResultsPage(project, query, result, deps.config.allowedImageHosts));
  });

  // ランダムなページへ移る（#258）。押したときだけ全ページのタイトルを読み、無作為に 1 つ選ぶ。
  app.get('/:project/random/page', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);
    const titles = await deps.storage.listPageTitles(project.id);
    const chosen = titles[Math.floor(Math.random() * titles.length)];
    return c.redirect(chosen === undefined ? `/${encodeURIComponent(project.name)}` : pageHref(project.name, chosen.title), 302);
  });

  app.get('/:project/:title/edit', (c) => {
    const url = new URL(c.req.url);
    const canonicalPath = url.pathname.slice(0, -'/edit'.length);
    return c.redirect(`${canonicalPath}${url.search}`, 308);
  });

  app.get('/:project/:title', async (c) => {
    const project = await resolveProject(deps.storage, c);
    if (project === null) return c.html(projectNotFoundPage(c.req.param('project')), 404);

    const rawTitle = safeDecode(c.req.param('title')) ?? c.req.param('title');
    const accountId = c.get('accountId');
    const actor = await deps.storage.getActorById(c.get('actorId'));
    const styleNonce = nonce();
    c.set('styleNonce', styleNonce);
    const page = await resolvePage(deps.storage, project.id, c);
    const renderConfig = {
      allowedImageHosts: deps.config.allowedImageHosts,
      allowedMediaHosts: deps.config.allowedMediaHosts,
    };
    const titles = await deps.storage.listKnownPages(project.id);
    const knownPagesList = titles.map(({ title, image }) => ({ title, image }));
    if (page === null) {
      c.status(404);
      // Cosense と同じく、URL のタイトルの _ は空白にする（#289）。ページが無いので本文のリンクもページの ID も無く、
      // 空の ID で、このタイトルへリンクしているページだけを関連ページとして得る。
      const title = rawTitle.replaceAll('_', ' ');
      const related = await deps.storage.getRelatedPages(project.id, '', titleLc(title));
      return c.html(emptyPageView(project, title, related, actor?.name ?? '', styleNonce, renderConfig, knownPagesList));
    }

    const previousVisit = await deps.storage.getVisit(accountId, page.id);
    const related = await deps.storage.getRelatedPages(project.id, page.id, page.titleLc);
    const knownPages = new Map(titles.map((entry) => [entry.titleLc, { title: entry.title, image: entry.image }]));
    // ページは無いが、ほかのページからリンクされているリンク先は、Cosense と同じく空リンクにしない（#285）。
    const linkedEmpty = linkedEmptyPages(page, related, new Set(knownPages.keys()));
    for (const entry of linkedEmpty) knownPages.set(titleLc(entry.title), entry);
    const pageKnownPages = [...knownPagesList, ...linkedEmpty];
    const rendered = renderLines(page.lines, knownPages, project.name, renderConfig);
    const isCrossSite = c.req.header('Sec-Fetch-Site')?.toLowerCase() === 'cross-site';
    const isPrefetch = c.req.header('Sec-Purpose')?.toLowerCase().includes('prefetch') === true;
    if (!isCrossSite && !isPrefetch) {
      await deps.storage.recordVisit(accountId, page.id, now(), page.version);
    }
    return c.html(
      pageViewPage(
        project,
        page,
        rendered,
        previousVisit,
        related,
        actor?.name ?? '',
        styleNonce,
        renderConfig,
        pageKnownPages,
        now(),
      ),
    );
  });
}
