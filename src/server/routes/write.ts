import { join } from 'node:path';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import { ulid } from '../../core/id.ts';
import { applyOps } from '../../core/apply.ts';
import { OpsError, type LineOp } from '../../core/ops.ts';
import { titleLc } from '../../core/title.ts';
import { InvalidExportError } from '../../core/cosense.ts';
import { exportCosense } from '../../storage/export.ts';
import { importCosense } from '../../application/importCosense.ts';
import { ATTACHMENT_IMPORT_TIMEOUT_MS } from '../../application/importAttachments.ts';
import { BadCommitError, StorageError, UnknownPageError, type CommitResult } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, pageToJson, resolveProject, safeDecode, type ApiEnv } from '../http.ts';

function isLineOp(op: unknown): op is LineOp {
  if (typeof op !== 'object' || op === null) return false;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const o = op as Record<string, unknown>;
  if (o.type === 'insert') return typeof o.id === 'string' && typeof o.after === 'string' && typeof o.text === 'string';
  if (o.type === 'update') return typeof o.id === 'string' && typeof o.text === 'string';
  if (o.type === 'delete') return typeof o.id === 'string';
  return false;
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function commitResultToResponse(c: Context, result: CommitResult): Response {
  if (result.kind === 'applied') return c.json({ version: result.version });
  return jsonError(c, 409, 'conflict', { reason: result.reason, page: pageToJson(result.page) });
}

export function registerWriteRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  app.post('/api/knot/projects/:project', async (c) => {
    try {
      const result = await storage.createProject(c.req.param('project'), now());
      const { project } = result;
      return c.json({
        id: project.id,
        name: project.name,
        displayName: project.displayName,
        created: result.kind === 'created',
      });
    } catch (e) {
      if (e instanceof StorageError) return jsonError(c, 400, 'bad_request', { message: e.message });
      throw e;
    }
  });

  app.post('/api/knot/projects/:project/import', async (c) => {
    const onConflict = c.req.query('onConflict') ?? 'skip';
    if (onConflict !== 'skip' && onConflict !== 'overwrite') {
      return jsonError(c, 400, 'bad_request', { message: `invalid onConflict: ${onConflict}` });
    }
    let data: unknown;
    try {
      data = await c.req.json();
    } catch {
      return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    }
    try {
      const summary = await importCosense(storage, data, {
        projectName: c.req.param('project'),
        onConflict,
        now: now(),
        attachments: {
          filesDir: join(deps.config.dataDir, 'files'),
          fetchFn: deps.fetchFn ?? fetch,
          maxBytes: deps.config.maxUploadBytes,
          timeoutMs: ATTACHMENT_IMPORT_TIMEOUT_MS,
        },
      });
      return c.json(summary);
    } catch (e) {
      if (e instanceof StorageError || e instanceof InvalidExportError) {
        return jsonError(c, 400, 'bad_request', { message: e.message });
      }
      throw e;
    }
  });

  app.get('/api/knot/projects/:project/export', async (c) => {
    const format = c.req.query('format') ?? 'full';
    if (format !== 'full' && format !== 'import') {
      return jsonError(c, 400, 'bad_request', { message: `invalid format: ${format}` });
    }
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    return c.json(await exportCosense(storage, project.name, format, now()));
  });

  app.delete('/api/knot/pages/:project/:title', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    // title は route 形状と percent-encoding の検証にだけ使い、削除対象は body の pageId で識別する。
    if (safeDecode(c.req.param('title')) === null) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (
      !body || typeof body.pageId !== 'string' || body.pageId === '' ||
      typeof body.baseVersion !== 'number' ||
      !Number.isInteger(body.baseVersion) || body.baseVersion < 0
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'pageId and baseVersion required' });
    }
    try {
      const result = await storage.deletePage({
        projectId: project.id,
        pageId: body.pageId,
        baseVersion: body.baseVersion,
        actorId: c.get('actorId'),
        now: now(),
      });
      if (result.kind === 'conflict') {
        return jsonError(c, 409, 'conflict', { reason: result.reason, page: pageToJson(result.page) });
      }
      return c.json({ deleted: true, version: result.version });
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 404, 'not_found');
      throw e;
    }
  });

  app.post('/api/knot/pages/:project/:title/rename', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    // title は route 形状と percent-encoding の検証にだけ使い、rename 対象は body の pageId で識別する。
    if (safeDecode(c.req.param('title')) === null) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (
      !body || typeof body.pageId !== 'string' || body.pageId === '' ||
      typeof body.newTitle !== 'string' ||
      typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 0
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'pageId, baseVersion and newTitle required' });
    }
    if (body.rewriteLinks !== undefined && typeof body.rewriteLinks !== 'boolean') {
      return jsonError(c, 400, 'bad_request', { message: 'rewriteLinks must be a boolean' });
    }
    const rewriteLinks = body.rewriteLinks === true;
    try {
      const result = await storage.renamePage({
        projectId: project.id, pageId: body.pageId, baseVersion: body.baseVersion, newTitle: body.newTitle,
        rewriteLinks, actorId: c.get('actorId'), now: now(),
      });
      if (result.kind === 'conflict') {
        return jsonError(c, 409, 'conflict', { reason: result.reason, page: pageToJson(result.page) });
      }
      return c.json({
        title: body.newTitle,
        version: result.version,
        rewritten: result.rewritten.map((r) => ({ id: r.pageId, title: r.title, version: r.version })),
      });
    } catch (e) {
      if (e instanceof UnknownPageError) return jsonError(c, 404, 'not_found');
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_request', { message: e.message });
      throw e;
    }
  });

  app.post('/api/knot/pages/:project/:title/commits', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    const { pageId: requestedPageId, commitId, baseVersion, ops } = body;
    if (
      (requestedPageId !== undefined && (typeof requestedPageId !== 'string' || requestedPageId === '')) ||
      typeof commitId !== 'string' || commitId === '' ||
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      !Array.isArray(ops) || ops.length === 0 || !ops.every(isLineOp)
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'commitId, baseVersion, ops required' });
    }

    const rawTitle = safeDecode(c.req.param('title'));
    if (rawTitle === null) return jsonError(c, 404, 'not_found');
    const urlTitleLc = titleLc(rawTitle);
    const page = requestedPageId === undefined
      ? await storage.getPageByTitle(project.id, urlTitleLc)
      : await storage.getPageById(requestedPageId);
    if (requestedPageId !== undefined && page === null) return jsonError(c, 404, 'not_found');
    if (page !== null && page.projectId !== project.id) {
      return jsonError(c, 404, 'not_found');
    }
    let pageId: string;
    if (page) {
      pageId = page.id;
    } else {
      if (baseVersion !== 0) return jsonError(c, 404, 'not_found');
      // 新規作成: 適用結果の先頭行タイトルが URL と一致することを純関数で事前検証する
      try {
        const lines = applyOps([], ops, { userId: c.get('actorId'), now: now(), version: 1 });
        if (lines.length === 0 || titleLc(lines[0]!.text) !== urlTitleLc) {
          return jsonError(c, 400, 'bad_request', { message: 'first line must match the URL title' });
        }
      } catch (e) {
        if (e instanceof OpsError) return jsonError(c, 400, 'bad_commit', { message: e.message });
        throw e;
      }
      pageId = ulid(now() * 1000);
    }

    try {
      const result = await storage.commit({
        projectId: project.id, pageId, commitId, baseVersion, ops,
        actorId: c.get('actorId'), now: now(),
      });
      if (result.kind === 'applied') return c.json({ version: result.version, pageId });
      return commitResultToResponse(c, result);
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_commit', { message: e.message });
      throw e;
    }
  });

  app.put('/api/knot/pages/:project/:title/text', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    const { pageId, baseVersion, text } = body;
    if (pageId !== undefined && (typeof pageId !== 'string' || pageId === '')) {
      return jsonError(c, 400, 'bad_request', { message: 'pageId must be a non-empty string' });
    }
    if (
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      typeof text !== 'string' || text === ''
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'baseVersion and non-empty text required' });
    }
    if (baseVersion !== 0 && pageId === undefined) {
      return jsonError(c, 400, 'bad_request', { message: 'pageId required for existing page' });
    }

    const rawTitle = safeDecode(c.req.param('title'));
    if (rawTitle === null) return jsonError(c, 404, 'not_found');
    try {
      const result = await storage.replacePageText({
        projectId: project.id,
        pageId: typeof pageId === 'string' ? pageId : null,
        urlTitleLc: titleLc(rawTitle),
        baseVersion,
        newTexts: text.split('\n'),
        actorId: c.get('actorId'),
        now: now(),
      });
      if (result.kind === 'applied') return c.json({ version: result.version, commitId: result.commitId });
      return commitResultToResponse(c, result);
    } catch (e) {
      if (e instanceof UnknownPageError) return jsonError(c, 404, 'not_found');
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_request', { message: e.message });
      throw e;
    }
  });
}
