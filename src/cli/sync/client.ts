import { encodeTitleForUrl } from '../../core/title.ts';

export type PageEntry = { id: string; title: string; version: number };
type RemotePage = { id: string; title: string; version: number; text: string };
type PutTextResult = { kind: 'ok'; version: number } | { kind: 'conflict' };

export class SyncHttpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
}

export type SyncClient = {
  listPages(): Promise<PageEntry[]>;
  getPage(title: string): Promise<RemotePage | null>;
  putText(title: string, baseVersion: number, text: string): Promise<PutTextResult>;
};

export function makeSyncClient(opts: {
  baseUrl: string;
  project: string;
  token: string;
  fetchFn?: typeof fetch;
}): SyncClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const authHeaders = { 'x-personal-access-token': opts.token };
  const projectSeg = encodeURIComponent(opts.project);

  // redirect: 'error' — 認証ヘッダを別 origin へ転送しない
  const get = async (path: string): Promise<Response> => {
    const res = await fetchFn(`${opts.baseUrl}${path}`, { headers: authHeaders, redirect: 'error' });
    if (res.status === 401) throw new SyncHttpError('unauthorized: check API token', 401);
    return res;
  };

  const listPages = async (): Promise<PageEntry[]> => {
    const out: PageEntry[] = [];
    let count = 0;
    for (;;) {
      const res = await get(`/api/pages/${projectSeg}?sort=title&limit=1000&skip=${out.length}`);
      if (!res.ok) throw new SyncHttpError(`page list failed: ${res.status}`, res.status);
      const body = (await res.json()) as { count: number; pages: Array<Partial<PageEntry>> };
      count = body.count;
      for (const p of body.pages) {
        if (typeof p.id !== 'string' || typeof p.title !== 'string') {
          throw new SyncHttpError('page list entry missing id/title');
        }
        if (typeof p.version !== 'number') {
          throw new SyncHttpError('server does not return version in page list; upgrade the knot server');
        }
        out.push({ id: p.id, title: p.title, version: p.version });
      }
      if (body.pages.length === 0 || out.length >= count) break;
    }
    if (out.length !== count) {
      throw new SyncHttpError(`page list incomplete: got ${out.length} of ${count}; retry later`);
    }
    if (new Set(out.map((p) => p.id)).size !== out.length) {
      throw new SyncHttpError('page list changed during fetch (duplicate ids); retry later');
    }
    return out;
  };

  const getPage = async (title: string): Promise<RemotePage | null> => {
    const res = await get(`/api/pages/${projectSeg}/${encodeTitleForUrl(title)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new SyncHttpError(`get page failed: ${res.status}`, res.status);
    const body = (await res.json()) as {
      id: string; title: string; version: number; lines: Array<{ text: string }>;
    };
    return { id: body.id, title: body.title, version: body.version, text: body.lines.map((l) => l.text).join('\n') };
  };

  const putText = async (title: string, baseVersion: number, text: string): Promise<PutTextResult> => {
    const res = await fetchFn(
      `${opts.baseUrl}/api/knot/pages/${projectSeg}/${encodeTitleForUrl(title)}/text`,
      {
        method: 'PUT',
        redirect: 'error',
        headers: { ...authHeaders, 'X-Knot-Client': 'knot-sync', 'content-type': 'application/json' },
        body: JSON.stringify({ baseVersion, text }),
      },
    );
    if (res.status === 401) throw new SyncHttpError('unauthorized: check API token', 401);
    if (res.status === 409) return { kind: 'conflict' };
    if (!res.ok) throw new SyncHttpError(`put failed: ${res.status}`, res.status);
    const body = (await res.json()) as { version: number };
    return { kind: 'ok', version: body.version };
  };

  return { listPages, getPage, putText };
}
