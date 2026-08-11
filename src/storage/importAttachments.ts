import { basename } from 'node:path';
import { parsePageSyntax, type SyntaxNode } from '../core/syntax.ts';
import { attachmentUrl, storeAttachment } from './attachmentFiles.ts';
import type { ImportLine, Storage } from './types.ts';

const COSENSE_FILES_ORIGIN = 'https://scrapbox.io';
export const ATTACHMENT_IMPORT_TIMEOUT_MS = 10_000;

const IMAGE_TYPES = {
  'image/png': { extension: '.png', matches: (bytes: Uint8Array) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) },
  'image/jpeg': { extension: '.jpg', matches: (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  'image/gif': { extension: '.gif', matches: (bytes: Uint8Array) => startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) },
  'image/webp': {
    extension: '.webp',
    matches: (bytes: Uint8Array) =>
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
} as const;

type ImageType = keyof typeof IMAGE_TYPES;

export type AttachmentImportOptions = {
  filesDir: string;
  fetchFn: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
};

export type AttachmentImportSummary = { created: number; reused: number; failed: number };

type CachedAttachment = { localUrl: string } | { localUrl: null };

export type AttachmentImportContext = {
  storage: Storage;
  projectId: string;
  userId: string;
  now: number;
  options: AttachmentImportOptions;
  cache: Map<string, CachedAttachment>;
  summary: AttachmentImportSummary;
};

function startsWith(bytes: Uint8Array, expected: number[]): boolean {
  return bytes.length >= expected.length && expected.every((value, index) => bytes[index] === value);
}

function isCosenseFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === COSENSE_FILES_ORIGIN && url.pathname.startsWith('/files/');
  } catch {
    return false;
  }
}

function collectUrls(lines: ImportLine[]): string[] {
  const source = lines.map((line) => line.text).join('\n');
  const urls = new Set<string>();
  const visit = (node: SyntaxNode): void => {
    const url = node.type === 'image' || node.type === 'strongImage'
      ? node.src
      : node.type === 'link' && node.pathType === 'absolute'
        ? node.href
        : undefined;
    if (url !== undefined && isCosenseFileUrl(url)) urls.add(url);
    if ('nodes' in node) for (const child of node.nodes) visit(child);
  };
  for (const block of parsePageSyntax(source, { hasTitle: true })) {
    if (block.type === 'line') for (const node of block.nodes) visit(node);
    if (block.type === 'table') for (const row of block.cells) for (const cell of row) for (const node of cell) visit(node);
  }
  return [...urls];
}

function responseImageType(response: Response): ImageType | undefined {
  const value = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
      return value;
    case undefined:
    default:
      return undefined;
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('attachment exceeds size limit');
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('attachment exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function attachmentFilename(sourceUrl: string, type: ImageType): string {
  const url = new URL(sourceUrl);
  let filename: string;
  try {
    filename = decodeURIComponent(basename(url.pathname));
  } catch {
    filename = basename(url.pathname);
  }
  filename = Array.from(
    filename,
    (character) => character.charCodeAt(0) < 0x20 || character === '/' || character === '\\' ? '_' : character,
  ).join('').slice(0, 200) || 'image';
  const { extension } = IMAGE_TYPES[type];
  const hasImageExtension = /\.(?:png|jpe?g|gif|webp)$/i.test(filename);
  return hasImageExtension ? filename : `${filename}${extension}`;
}

async function importOne(sourceUrl: string, context: AttachmentImportContext): Promise<CachedAttachment> {
  const cached = context.cache.get(sourceUrl);
  if (cached !== undefined) return cached;
  try {
    const response = await context.options.fetchFn(sourceUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(context.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`attachment fetch failed: ${response.status}`);
    const type = responseImageType(response);
    if (type === undefined) throw new Error('unsupported attachment content type');
    const bytes = await readLimited(response, context.options.maxBytes);
    if (!IMAGE_TYPES[type].matches(bytes)) throw new Error('attachment content does not match content type');
    const stored = await storeAttachment({
      storage: context.storage,
      filesDir: context.options.filesDir,
      projectId: context.projectId,
      filename: attachmentFilename(sourceUrl, type),
      contentType: type,
      bytes,
      userId: context.userId,
      now: context.now,
    });
    if (stored.created) context.summary.created++;
    else context.summary.reused++;
    const result = { localUrl: attachmentUrl(stored.attachment) };
    context.cache.set(sourceUrl, result);
    return result;
  } catch {
    context.summary.failed++;
    const result = { localUrl: null };
    context.cache.set(sourceUrl, result);
    return result;
  }
}

export async function importAttachments(lines: ImportLine[], context: AttachmentImportContext): Promise<ImportLine[]> {
  const replacements = new Map<string, string>();
  for (const sourceUrl of collectUrls(lines)) {
    const { localUrl } = await importOne(sourceUrl, context);
    if (localUrl !== null) replacements.set(sourceUrl, localUrl);
  }
  if (replacements.size === 0) return lines;
  return lines.map((line) => {
    let text = line.text;
    for (const [sourceUrl, localUrl] of replacements) text = text.replaceAll(sourceUrl, localUrl);
    return text === line.text ? line : { ...line, text };
  });
}
