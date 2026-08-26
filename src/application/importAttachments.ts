import { basename } from 'node:path';
import { parsePageSyntax, type SyntaxNode } from '../core/syntax.ts';
import { attachmentUrl, storeAttachment } from './attachments.ts';
import type { AttachmentRepository, ImportLine } from '../storage/types.ts';

const COSENSE_FILES_ORIGIN = 'https://scrapbox.io';
const COSENSE_FILES_REDIRECT_ORIGIN = 'https://storage.googleapis.com';
const COSENSE_FILES_REDIRECT_PATH = '/scrapbox-file-distribute/';
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
type UrlOccurrence = { sourceUrl: string; from: number; to: number };

export type AttachmentImportContext = {
  storage: AttachmentRepository;
  projectId: string;
  actorId: string;
  now: number;
  options: AttachmentImportOptions;
  cache: Map<string, CachedAttachment>;
  claimOwner: string;
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

function imageSourceFrom(node: Extract<SyntaxNode, { type: 'image' | 'strongImage' }>): number | undefined {
  if (node.type === 'strongImage') {
    return node.raw.slice(2, -2) === node.src ? node.range.from + 2 : undefined;
  }
  const content = node.raw.slice(1, -1);
  const separatorFrom = content.search(/\s/);
  if (separatorFrom < 0) return content === node.src ? node.range.from + 1 : undefined;
  const secondOffset = content.slice(separatorFrom).search(/\S/);
  const secondFrom = secondOffset < 0 ? -1 : separatorFrom + secondOffset;
  if (secondFrom >= 0 && content.slice(secondFrom) === node.src) return node.range.from + secondFrom + 1;
  if (content.slice(0, separatorFrom) === node.src) return node.range.from + 1;
  return undefined;
}

function collectUrlOccurrences(lines: ImportLine[]): UrlOccurrence[] {
  const source = lines.map((line) => line.text).join('\n');
  const occurrences: UrlOccurrence[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'image' || node.type === 'strongImage') {
      const url = node.src;
      if (isCosenseFileUrl(url)) {
        const sourceFrom = imageSourceFrom(node);
        if (sourceFrom === undefined || source.slice(sourceFrom, sourceFrom + url.length) !== url) {
          throw new Error('attachment image syntax does not contain src at the expected range');
        }
        occurrences.push({ sourceUrl: url, from: sourceFrom, to: sourceFrom + url.length });
      }
    }
    if ('nodes' in node) for (const child of node.nodes) visit(child);
  };
  for (const block of parsePageSyntax(source, { hasTitle: true })) {
    if (block.type === 'line') for (const node of block.nodes) visit(node);
    if (block.type === 'table') for (const row of block.cells) for (const cell of row) for (const node of cell) visit(node);
  }
  return occurrences;
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
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('attachment exceeds size limit');
  }
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

async function rejectResponse(response: Response, message: string): Promise<never> {
  await response.body?.cancel();
  throw new Error(message);
}

function isAllowedRedirect(url: URL): boolean {
  return url.origin === COSENSE_FILES_REDIRECT_ORIGIN
    && url.username === ''
    && url.password === ''
    && url.pathname.startsWith(COSENSE_FILES_REDIRECT_PATH);
}

async function fetchImage(sourceUrl: string, context: AttachmentImportContext): Promise<{
  type: ImageType;
  bytes: Uint8Array;
}> {
  const signal = AbortSignal.timeout(context.options.timeoutMs);
  let response = await context.options.fetchFn(sourceUrl, { redirect: 'manual', signal });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (location === null) throw new Error('attachment redirect has no location');
    const redirected = new URL(location, sourceUrl);
    if (!isAllowedRedirect(redirected)) throw new Error('attachment redirect destination is not allowed');
    response = await context.options.fetchFn(redirected, { redirect: 'error', signal });
  }
  if (!response.ok) return rejectResponse(response, `attachment fetch failed: ${response.status}`);
  const type = responseImageType(response);
  if (type === undefined) return rejectResponse(response, 'unsupported attachment content type');
  const bytes = await readLimited(response, context.options.maxBytes);
  if (!IMAGE_TYPES[type].matches(bytes)) throw new Error('attachment content does not match content type');
  return { type, bytes };
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
  ).slice(0, 200).join('') || 'image';
  const { extension } = IMAGE_TYPES[type];
  const hasImageExtension = /\.(?:png|jpe?g|gif|webp)$/i.test(filename);
  return hasImageExtension ? filename : `${filename}${extension}`;
}

async function importOne(sourceUrl: string, context: AttachmentImportContext): Promise<CachedAttachment> {
  const cached = context.cache.get(sourceUrl);
  if (cached !== undefined) return cached;
  let fetched: { type: ImageType; bytes: Uint8Array };
  try {
    fetched = await fetchImage(sourceUrl, context);
  } catch {
    context.summary.failed++;
    const result = { localUrl: null };
    context.cache.set(sourceUrl, result);
    return result;
  }
  const filename = attachmentFilename(sourceUrl, fetched.type);
  const stored = await storeAttachment({
    storage: context.storage,
    filesDir: context.options.filesDir,
    projectId: context.projectId,
    filename,
    contentType: fetched.type,
    bytes: fetched.bytes,
    actorId: context.actorId,
    now: context.now,
    replaceGenericMetadata: true,
    claimOwner: context.claimOwner,
  });
  if (stored.created) {
    context.summary.created++;
  } else context.summary.reused++;
  const result = { localUrl: attachmentUrl(stored.attachment) };
  context.cache.set(sourceUrl, result);
  return result;
}

export async function importAttachments(lines: ImportLine[], context: AttachmentImportContext): Promise<ImportLine[]> {
  const occurrences = collectUrlOccurrences(lines);
  const replacements = new Map<string, string>();
  for (const sourceUrl of new Set(occurrences.map((occurrence) => occurrence.sourceUrl))) {
    const { localUrl } = await importOne(sourceUrl, context);
    if (localUrl !== null) replacements.set(sourceUrl, localUrl);
  }
  if (replacements.size === 0) return lines;
  let lineFrom = 0;
  return lines.map((line) => {
    const lineTo = lineFrom + line.text.length;
    let text = line.text;
    for (const occurrence of occurrences
      .filter(({ from, to }) => from >= lineFrom && to <= lineTo)
      .toSorted((left, right) => right.from - left.from)) {
      const localUrl = replacements.get(occurrence.sourceUrl);
      if (localUrl === undefined) continue;
      const from = occurrence.from - lineFrom;
      const to = occurrence.to - lineFrom;
      text = text.slice(0, from) + localUrl + text.slice(to);
    }
    lineFrom = lineTo + 1;
    return text === line.text ? line : { ...line, text };
  });
}
