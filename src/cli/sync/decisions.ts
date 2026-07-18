import type { PageEntry } from './client.ts';
import type { SyncState } from './state.ts';

export type PullAction =
  | { kind: 'write'; pageId: string; title: string }
  | { kind: 'conflict'; pageId: string; title: string }
  | { kind: 'delete-local'; pageId: string }
  | { kind: 'keep-deleted'; pageId: string };

export function planPull(input: {
  state: SyncState;
  remote: PageEntry[];
  localHashes: Map<string, string>;
}): PullAction[] {
  const actions: PullAction[] = [];
  const remoteIds = new Set(input.remote.map((p) => p.id));
  for (const p of input.remote) {
    const st = input.state.pages[p.id];
    if (st === undefined) {
      actions.push({ kind: 'write', pageId: p.id, title: p.title });
      continue;
    }
    const localHash = input.localHashes.get(st.filename);
    const localMissing = localHash === undefined;
    const localChanged = !localMissing && localHash !== st.contentHash;
    const remoteChanged = p.version !== st.version || p.title !== st.title;
    if (!remoteChanged && !localMissing) continue; // 未変更、またはローカル変更のみ（push 待ち）
    if (remoteChanged && localChanged) {
      actions.push({ kind: 'conflict', pageId: p.id, title: p.title });
      continue;
    }
    // リモート更新 or リネーム or ローカル消失の復元
    actions.push({ kind: 'write', pageId: p.id, title: p.title });
  }
  for (const [pageId, st] of Object.entries(input.state.pages)) {
    if (remoteIds.has(pageId)) continue;
    const localHash = input.localHashes.get(st.filename);
    const localChanged = localHash !== undefined && localHash !== st.contentHash;
    actions.push(localChanged ? { kind: 'keep-deleted', pageId } : { kind: 'delete-local', pageId });
  }
  return actions;
}
