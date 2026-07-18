import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { titleLc } from '../../core/title.ts';
import { CliError } from '../commands.ts';
import { canonicalizeText, contentHash } from './canonical.ts';
import { makeSyncClient, type SyncClient } from './client.ts';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from './config.ts';
import { planPull } from './decisions.ts';
import { titleToFilename } from './filenames.ts';
import { loadState, saveState, type SyncState } from './state.ts';

export type SyncResult = { output: string; exitCode: 0 | 1 | 2 };
export type SyncDeps = { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv };

export const SYNC_USAGE = `usage:
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull   [--dir <dir>]
  knot sync push   [--dir <dir>] [--force]
  knot sync status [--dir <dir>] [--remote]`;

export type LocalFile = { firstLine: string; contentHash: string; canonical: string };

// 同期ディレクトリ直下の .txt を走査する（.knot/ とサブディレクトリは対象外）
export function readLocalFiles(dir: string): Map<string, LocalFile> {
  const out = new Map<string, LocalFile>();
  const names = readdirSync(dir).toSorted();
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const canonical = canonicalizeText(readFileSync(path, 'utf8'));
    out.set(name, { firstLine: canonical.split('\n')[0] ?? '', contentHash: contentHash(canonical), canonical });
  }
  return out;
}

async function runInit(positionals: string[], values: Record<string, unknown>): Promise<SyncResult> {
  const dir = positionals[0];
  const url = values.url as string | undefined;
  const project = values.project as string | undefined;
  if (dir === undefined || url === undefined || project === undefined) throw new CliError(SYNC_USAGE);
  writeSyncConfig(dir, { url: normalizeBaseUrl(url), project });
  return {
    exitCode: 0,
    output: [
      `initialized sync directory for project "${project}"`,
      'next steps:',
      '  - echo ".knot/" >> .gitignore   (トークンと state を git 管理に入れない)',
      '  - export KNOT_TOKEN=knot_...    (または .knot/token に保存し chmod 600)',
      '  - knot sync pull',
    ].join('\n'),
  };
}

async function runStatus(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  loadSyncConfig(dir); // sync ディレクトリでなければ CliError
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  const lines: string[] = [];
  const known = new Set<string>();
  for (const st of Object.values(state.pages)) {
    known.add(st.filename);
    const file = local.get(st.filename);
    if (file === undefined) lines.push(`missing:  ${st.filename}`);
    else if (file.contentHash !== st.contentHash) lines.push(`modified: ${st.filename}`);
  }
  for (const name of local.keys()) {
    if (!known.has(name)) lines.push(`new:      ${name}`);
  }
  if (values.remote === true) {
    lines.push(...(await remoteStatusLines(dir, deps)));
  }
  return { exitCode: 0, output: lines.length === 0 ? 'clean' : lines.join('\n') };
}

function openClient(dir: string, deps: SyncDeps): { client: SyncClient } {
  const config = loadSyncConfig(dir);
  const token = resolveToken(dir, deps.env);
  return { client: makeSyncClient({ baseUrl: config.url, project: config.project, token, fetchFn: deps.fetchFn }) };
}

async function remoteStatusLines(dir: string, deps: SyncDeps): Promise<string[]> {
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const remote = await client.listPages();
  const lines: string[] = [];
  for (const p of remote) {
    const st = state.pages[p.id];
    if (st === undefined) lines.push(`remote-new:     ${p.title}`);
    else if (p.version !== st.version || p.title !== st.title) lines.push(`remote-changed: ${p.title}`);
  }
  const remoteIds = new Set(remote.map((p) => p.id));
  for (const [pageId, st] of Object.entries(state.pages)) {
    if (!remoteIds.has(pageId)) lines.push(`remote-deleted: ${st.filename}`);
  }
  return lines;
}

// 衝突しないファイル名を決める: 既定はタイトル由来。次のどちらかに該当する場合だけ ~2, ~3 … を付ける。
//   1. state 上で別ページ（pageId が異なるエントリ）が既にそのファイル名を使っている
//   2. 実 FS 上に別ファイルとしてそのファイル名が既に存在する（このページ自身の現行ファイル名を除く）
// 2 は state 未追跡の既存ファイルの黙殺上書きや、ケースフォールディング FS（例: Σ/ς）での
// データ消失を防ぐため。100 回試して割り当てられなければ諦める。
function chooseFilename(dir: string, state: SyncState, pageId: string, title: string): string {
  const base = titleToFilename(title);
  const stem = base.replace(/\.txt$/, '');
  const taken = new Set(
    Object.entries(state.pages).filter(([id]) => id !== pageId).map(([, st]) => st.filename),
  );
  const own = state.pages[pageId]?.filename;
  for (let i = 1; i <= 100; i += 1) {
    const candidate = i === 1 ? base : `${stem}~${i}.txt`;
    const takenByState = taken.has(candidate);
    const existsOnDisk = candidate !== own && existsSync(join(dir, candidate));
    if (!takenByState && !existsOnDisk) return candidate;
  }
  throw new CliError(`cannot allocate filename for: ${title}`);
}

export async function runSync(argv: string[], deps: SyncDeps = {}): Promise<SyncResult> {
  try {
    const [sub, ...rest] = argv;
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        project: { type: 'string' },
        dir: { type: 'string' },
        force: { type: 'boolean' },
        remote: { type: 'boolean' },
      },
    });
    switch (sub) {
      case 'init':
        return await runInit(positionals, values);
      case 'status':
        return await runStatus(values, deps);
      case 'pull':
        return await runPull(values, deps);
      case 'push':
        return await runPush(values, deps);
      default:
        throw new CliError(SYNC_USAGE);
    }
  } catch (e) {
    if (e instanceof CliError) return { exitCode: 2, output: e.message };
    throw e;
  }
}

async function runPull(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  let remote;
  try {
    remote = await client.listPages();
  } catch (e) {
    // SyncHttpError（サーバ応答由来）に加え、接続拒否・DNS・タイムアウト等の
    // transport 失敗（fetch が Response を返す前に reject）でもクラッシュさせず exitCode 2 で終える。
    return { exitCode: 2, output: e instanceof Error ? e.message : String(e) };
  }
  const remoteById = new Map(remote.map((p) => [p.id, p]));
  const localHashes = new Map([...local].map(([name, f]) => [name, f.contentHash]));
  const report: string[] = [];
  let dirty = false;

  for (const action of planPull({ state, remote, localHashes })) {
    if (action.kind === 'delete-local') {
      const st = state.pages[action.pageId]!;
      rmSync(join(dir, st.filename), { force: true });
      delete state.pages[action.pageId];
      saveState(dir, state);
      report.push(`deleted: ${st.filename}`);
      continue;
    }
    if (action.kind === 'keep-deleted') {
      report.push(`kept (deleted on remote, locally modified): ${state.pages[action.pageId]!.filename}`);
      dirty = true;
      continue;
    }
    // write / conflict は詳細を取得し、id の一致を必ず検証する
    // （削除済みページのタイトルは再利用されうるため、タイトル解決が別ページを返す危険がある）
    const summary = remoteById.get(action.pageId)!;
    let detail;
    try {
      detail = await client.getPage(action.title);
    } catch {
      // SyncHttpError だけでなく、transport 失敗（接続拒否・DNS・タイムアウト等）でも
      // そのページだけスキップし、他ページの処理は続行する（state/ファイルは不変）。
      report.push(`skipped (fetch failed): ${action.title}`);
      dirty = true;
      continue;
    }
    if (detail === null || detail.id !== summary.id) {
      report.push(`skipped (page moved during pull): ${action.title}`);
      dirty = true;
      continue;
    }
    if (action.kind === 'conflict') {
      const cdir = join(dir, '.knot', 'conflicts', action.pageId);
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, 'remote.txt'), `${detail.text}\n`);
      report.push(`conflict: ${state.pages[action.pageId]!.filename} (remote copy in .knot/conflicts/${action.pageId}/)`);
      dirty = true;
      continue;
    }
    // write: リネームなら新ファイルを書いてから旧ファイルを消す（write 失敗時に両方失わない）
    const prev = state.pages[action.pageId];
    const filename = prev !== undefined && titleLc(prev.title) === titleLc(detail.title)
      ? prev.filename
      : chooseFilename(dir, state, action.pageId, detail.title);
    writeFileSync(join(dir, filename), `${detail.text}\n`);
    if (prev !== undefined && prev.filename !== filename) rmSync(join(dir, prev.filename), { force: true });
    state.pages[action.pageId] = {
      title: detail.title, filename, version: detail.version, contentHash: contentHash(detail.text),
    };
    saveState(dir, state);
    report.push(`pulled: ${filename}`);
  }
  return { exitCode: dirty ? 1 : 0, output: report.length === 0 ? 'up to date' : report.join('\n') };
}
async function runPush(_values: Record<string, unknown>, _deps: SyncDeps): Promise<SyncResult> {
  throw new CliError('push is not implemented yet');
}
