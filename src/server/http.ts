import type { Context } from 'hono';
import { titleLc } from '../core/title.ts';
import type { PageSnapshot, Project, Storage } from '../storage/types.ts';

export type ApiEnv = { Variables: { userId: string; styleNonce?: string } };

export function jsonError(c: Context, status: number, error: string, extra?: Record<string, unknown>): Response {
  return c.json({ error, ...extra }, status as 400);
}

export function pageToJson(page: PageSnapshot) {
  return {
    id: page.id,
    title: page.title,
    version: page.version,
    created: page.created,
    updated: page.updated,
    lines: page.lines.map((l) => ({
      id: l.id,
      text: l.text,
      userId: l.userId,
      created: l.created,
      updated: l.updated,
    })),
  };
}

export function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'local';
}

export async function resolveProject(storage: Storage, c: Context): Promise<Project | null> {
  const project = c.req.param('project');
  return project === undefined ? null : storage.getProject(project);
}

/** 不正な percent-encoding（例: '%E0%A4%A'）で URIError を 500 にしない */
export function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export async function resolvePage(storage: Storage, projectId: string, c: Context): Promise<PageSnapshot | null> {
  const segment = c.req.param('title');
  if (segment === undefined) return null;
  const title = safeDecode(segment);
  if (title === null) return null;
  return storage.getPageByTitle(projectId, titleLc(title));
}
