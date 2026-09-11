import { join } from 'node:path';
import type { Hono } from 'hono';
import { importCosense } from '../../application/importCosense.ts';
import { ATTACHMENT_IMPORT_TIMEOUT_MS } from '../../application/importAttachments.ts';
import { InvalidExportError } from '../../core/cosense.ts';
import { exportCosense } from '../../storage/export.ts';
import { StorageError } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, resolveProject, type ApiEnv } from '../http.ts';

export function registerProjectTransferRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

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
}
