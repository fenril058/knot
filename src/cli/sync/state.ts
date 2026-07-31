import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type PageState = {
  title: string;
  filename: string;
  version: number;
  contentHash: string;
};

export type SyncState = { pages: Record<string, PageState> };

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
