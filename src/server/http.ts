import type { Context } from 'hono';
import type { PageSnapshot } from '../storage/types.ts';

export type ApiEnv = { Variables: { userId: string } };

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
