import type { Hono } from 'hono';
import type { Context } from 'hono';
import { ulid } from '../../core/id.ts';
import { applyOps } from '../../core/apply.ts';
import { OpsError, type LineOp } from '../../core/ops.ts';
import { titleLc } from '../../core/title.ts';
import { BadCommitError, type CommitResult } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, pageToJson, resolveProject, safeDecode, type ApiEnv } from '../http.ts';

function isLineOp(op: unknown): op is LineOp {
  if (typeof op !== 'object' || op === null) return false;
  const o = op as Record<string, unknown>;
  if (o.type === 'insert') return typeof o.id === 'string' && typeof o.after === 'string' && typeof o.text === 'string';
  if (o.type === 'update') return typeof o.id === 'string' && typeof o.text === 'string';
  if (o.type === 'delete') return typeof o.id === 'string';
  return false;
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
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

  app.post('/api/knot/pages/:project/:title/commits', async (c) => {
    const project = await resolveProject(storage, c);
    if (!project) return jsonError(c, 404, 'not_found');
    const body = await readJson(c);
    if (!body) return jsonError(c, 400, 'bad_request', { message: 'invalid JSON' });
    const { commitId, baseVersion, ops } = body;
    if (
      typeof commitId !== 'string' || commitId === '' ||
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0 ||
      !Array.isArray(ops) || ops.length === 0 || !ops.every(isLineOp)
    ) {
      return jsonError(c, 400, 'bad_request', { message: 'commitId, baseVersion, ops required' });
    }

    const rawTitle = safeDecode(c.req.param('title'));
    if (rawTitle === null) return jsonError(c, 404, 'not_found');
    const urlTitleLc = titleLc(rawTitle);
    const page = await storage.getPageByTitle(project.id, urlTitleLc);
    let pageId: string;
    if (page) {
      pageId = page.id;
    } else {
      if (baseVersion !== 0) return jsonError(c, 404, 'not_found');
      // 新規作成: 適用結果の先頭行タイトルが URL と一致することを純関数で事前検証する
      try {
        const lines = applyOps([], ops, { userId: c.get('userId'), now: now(), version: 1 });
        if (lines.length === 0 || titleLc(lines[0].text) !== urlTitleLc) {
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
        userId: c.get('userId'), now: now(),
      });
      return commitResultToResponse(c, result);
    } catch (e) {
      if (e instanceof BadCommitError) return jsonError(c, 400, 'bad_commit', { message: e.message });
      throw e;
    }
  });
}
