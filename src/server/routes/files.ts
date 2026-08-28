import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { attachmentUrl, storeAttachment } from '../../application/attachments.ts';
import type { Attachment } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { INLINE_TYPES, MAGIC } from '../fileContentTypes.ts';
import { jsonError, type ApiEnv } from '../http.ts';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function attachmentToJson(attachment: Pick<Attachment, 'id' | 'filename' | 'contentType' | 'size' | 'sha256'>) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
    url: attachmentUrl(attachment),
  };
}

export function registerFileRoutes(app: Hono<ApiEnv>, deps: AppDeps): void {
  const { storage, config } = deps;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const filesDir = join(config.dataDir, 'files');

  app.post('/api/knot/files', async (c) => {
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > config.maxUploadBytes + 64 * 1024) return jsonError(c, 413, 'too_large');

    let form: Awaited<ReturnType<typeof c.req.parseBody>>;
    try {
      form = await c.req.parseBody();
    } catch {
      return jsonError(c, 400, 'bad_request', { message: 'invalid multipart body' });
    }
    const file = form.file;
    const projectName = form.project;
    if (!(file instanceof File) || typeof projectName !== 'string') {
      return jsonError(c, 400, 'bad_request', { message: 'file and project required' });
    }
    const project = await storage.getProject(projectName);
    if (!project) return jsonError(c, 400, 'bad_request', { message: `unknown project: ${projectName}` });
    if (file.size > config.maxUploadBytes) return jsonError(c, 413, 'too_large');

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > config.maxUploadBytes) return jsonError(c, 413, 'too_large');
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    const check = MAGIC[contentType];
    if (check && !check(bytes)) {
      return jsonError(c, 400, 'bad_request', { message: `content does not match ${contentType}` });
    }

    const stored = await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: file.name,
      contentType,
      bytes,
      actorId: c.get('actorId'),
      now: now(),
    });
    return c.json(attachmentToJson(stored.attachment));
  });

  const serveFile = async (c: Context<ApiEnv>): Promise<Response> => {
    const id = c.req.param('id');
    if (id === undefined || !ULID_RE.test(id)) return jsonError(c, 404, 'not_found');
    const attachment = await storage.getAttachment(id);
    if (!attachment) return jsonError(c, 404, 'not_found');
    let bytes: Buffer;
    try {
      bytes = await readFile(join(filesDir, attachment.id));
    } catch {
      return jsonError(c, 404, 'not_found');
    }
    c.header('Content-Type', attachment.contentType);
    if (!INLINE_TYPES.includes(attachment.contentType)) {
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    }
    return c.body(new Uint8Array(bytes));
  };

  app.get('/files/:id', serveFile);
  app.get('/files/:id/:filename', serveFile);
}
