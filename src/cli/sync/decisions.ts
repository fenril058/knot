import { titleLc } from '../../core/title.ts';
import type { PageEntry } from './client.ts';
import { filenameToTitle } from './filenames.ts';
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

export type PushAction =
  | { kind: 'update'; pageId: string; filename: string; title: string; baseVersion: number }
  | { kind: 'create'; filename: string; title: string }
  | { kind: 'skip-rename'; filename: string; stateTitle: string; fileTitle: string }
  | { kind: 'skip-title-mismatch'; filename: string; fileTitle: string }
  | { kind: 'skip-duplicate'; filename: string; title: string };

export function planPush(input: {
  state: SyncState;
  localFiles: Map<string, { firstLine: string; contentHash: string }>;
  remoteTitleLcs: Set<string>;
}): PushAction[] {
  const actions: PushAction[] = [];
  const byFilename = new Map(
    Object.entries(input.state.pages).map(([id, st]) => [st.filename, { id, st }]),
  );
  const claimedLcs = new Set<string>();
  for (const [filename, file] of input.localFiles) {
    const entry = byFilename.get(filename);
    if (entry !== undefined) {
      if (file.contentHash === entry.st.contentHash) continue;
      if (titleLc(file.firstLine) !== titleLc(entry.st.title)) {
        // サーバは既存ページのタイトル行変更をリネームとして受理してしまうため、CLI 側で拒否する
        actions.push({ kind: 'skip-rename', filename, stateTitle: entry.st.title, fileTitle: file.firstLine });
        continue;
      }
      actions.push({ kind: 'update', pageId: entry.id, filename, title: entry.st.title, baseVersion: entry.st.version });
      continue;
    }
    const title = file.firstLine;
    const lc = titleLc(title);
    if (titleLc(filenameToTitle(filename)) !== lc) {
      actions.push({ kind: 'skip-title-mismatch', filename, fileTitle: title });
      continue;
    }
    if (input.remoteTitleLcs.has(lc) || claimedLcs.has(lc)) {
      actions.push({ kind: 'skip-duplicate', filename, title });
      continue;
    }
    claimedLcs.add(lc);
    actions.push({ kind: 'create', filename, title });
  }
  return actions;
}
