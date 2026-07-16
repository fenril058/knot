import type { Line, LineOp } from '../../core/ops.ts';
import { encodeTitleForUrl } from '../../core/title.ts';
import type { Snapshot } from './sync.ts';

type PageJson = {
  title: string;
  version: number;
  lines: Array<{
    id: string;
    text: string;
    userId: string;
    created: number;
    updated: number;
  }>;
};

function pagePath(project: string, title: string): string {
  return `/api/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(title)}`;
}

function commitPath(project: string, title: string): string {
  return `/api/knot/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(title)}/commits`;
}

function toSnapshot(page: PageJson): Snapshot {
  return {
    version: page.version,
    lines: page.lines.map((line) => ({ ...line, updatedVersion: page.version })),
  };
}

export async function fetchPage(
  project: string,
  title: string,
): Promise<{ title: string; snapshot: Snapshot } | null> {
  const response = await fetch(pagePath(project, title));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`page fetch failed: ${response.status}`);

  const page = await response.json() as PageJson;
  return { title: page.title, snapshot: toSnapshot(page) };
}

export async function postCommit(
  project: string,
  title: string,
  commit: { commitId: string; baseVersion: number; ops: LineOp[] },
  opts?: { keepalive?: boolean },
): Promise<
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; page: { version: number; title: string; lines: Line[] } }
  | { kind: 'bad'; message: string }
  | { kind: 'network' }
> {
  try {
    const response = await fetch(commitPath(project, title), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Knot-Client': 'editor' },
      body: JSON.stringify(commit),
      keepalive: opts?.keepalive,
    });
    // 5xx はネットワーク断と同じく復帰可能扱い（同じ commitId で再送する）
    if (response.status >= 500) return { kind: 'network' };
    const body = await response.json() as {
      version?: number;
      message?: string;
      page?: PageJson;
    };

    if (response.ok && typeof body.version === 'number') {
      return { kind: 'ok', version: body.version };
    }
    if (response.status === 409 && body.page !== undefined) {
      const snapshot = toSnapshot(body.page);
      return {
        kind: 'conflict',
        page: { version: snapshot.version, title: body.page.title, lines: snapshot.lines },
      };
    }
    return { kind: 'bad', message: body.message ?? `HTTP ${response.status}` };
  } catch {
    return { kind: 'network' };
  }
}

export async function uploadFile(
  project: string,
  file: File,
): Promise<{ kind: 'ok'; url: string } | { kind: 'error'; message: string }> {
  const form = new FormData();
  form.append('file', file);
  form.append('project', project);
  try {
    const response = await fetch('/api/knot/files', {
      method: 'POST',
      headers: { 'X-Knot-Client': 'editor' },
      body: form,
    });
    const body = await response.json() as { url?: string; message?: string };
    if (response.ok && typeof body.url === 'string') return { kind: 'ok', url: body.url };
    return { kind: 'error', message: body.message ?? `HTTP ${response.status}` };
  } catch {
    return { kind: 'error', message: 'network error' };
  }
}
