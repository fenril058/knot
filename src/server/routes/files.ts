import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { attachmentUrl, storeAttachment } from '../../storage/attachmentFiles.ts';
import type { Attachment } from '../../storage/types.ts';
import type { AppDeps } from '../app.ts';
import { jsonError, type ApiEnv } from '../http.ts';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]);

const startsWith = (bytes: Uint8Array, offset: number, expected: number[]): boolean =>
  bytes.length >= offset + expected.length && expected.every((value, index) => bytes[offset + index] === value);

const MAGIC: Record<string, (bytes: Uint8Array) => boolean> = {
  'image/png': (bytes) => startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (bytes) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  'image/gif': (bytes) => startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]),
  'image/webp': (bytes) =>
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50]),
  'video/mp4': (bytes) => startsWith(bytes, 4, [0x66, 0x74, 0x79, 0x70]),
  'video/webm': (bytes) => startsWith(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  'audio/mpeg': (bytes) =>
    startsWith(bytes, 0, [0x49, 0x44, 0x33]) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0),
  'audio/ogg': (bytes) => startsWith(bytes, 0, [0x4f, 0x67, 0x67, 0x53]),
  'audio/wav': (bytes) =>
    startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x41, 0x56, 0x45]),
};

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
      userId: c.get('userId'),
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
    if (!INLINE_TYPES.has(attachment.contentType)) {
      c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    }
    return c.body(new Uint8Array(bytes));
  };

  app.get('/files/:id', serveFile);
  app.get('/files/:id/:filename', serveFile);
}
