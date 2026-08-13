import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PageState = {
  title: string;
  filename: string;
  version: number;
  contentHash: string;
};

export type SyncState = { pages: Record<string, PageState> };

export type PendingPullRename = {
  pageId: string;
  from: PageState;
  to: PageState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPageState(value: unknown): value is PageState {
  return isRecord(value)
    && typeof value.title === 'string'
    && typeof value.filename === 'string'
    && typeof value.version === 'number'
    && typeof value.contentHash === 'string';
}

export function loadState(dir: string): SyncState {
  const path = join(dir, '.knot', 'state.json');
  if (!existsSync(path)) return { pages: {} };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(readFileSync(path, 'utf8')) as SyncState;
}

// アトミック書き込み(tmp + rename)。ページ 1 件の成功ごとに呼ぶ。
export function saveState(dir: string, state: SyncState): void {
  const path = join(dir, '.knot', 'state.json');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function loadPendingPullRename(dir: string): PendingPullRename | undefined {
  const path = join(dir, '.knot', 'pending-pull-rename.json');
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(value)
    || typeof value.pageId !== 'string'
    || !isPageState(value.from)
    || !isPageState(value.to)) {
    throw new Error('invalid pending pull rename record');
  }
  return { pageId: value.pageId, from: value.from, to: value.to };
}

export function savePendingPullRename(dir: string, pending: PendingPullRename): void {
  const path = join(dir, '.knot', 'pending-pull-rename.json');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearPendingPullRename(dir: string): void {
  rmSync(join(dir, '.knot', 'pending-pull-rename.json'), { force: true });
}
