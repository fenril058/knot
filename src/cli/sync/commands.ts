import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { titleLc } from '../../core/title.ts';
import { CliError } from '../commands.ts';
import { canonicalizeText, contentHash } from './canonical.ts';
import { makeSyncClient, SyncHttpError, type SyncClient } from './client.ts';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from './config.ts';
import { planPull, planPush } from './decisions.ts';
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

// 401 は runPush のどこで起きても即 exitCode 2。副次呼び出し内では投げ直してループ外の catch で拾う。
function is401(e: unknown): boolean {
  return e instanceof SyncHttpError && e.status === 401;
}

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
async function runPush(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const force = values.force === true;
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  let remote;
  try {
    remote = await client.listPages();
  } catch (e) {
    if (e instanceof SyncHttpError) return { exitCode: 2, output: e.message };
    // transport 失敗（接続拒否・DNS・タイムアウト等）でもクラッシュさせず exitCode 2 で終える
    return { exitCode: 2, output: e instanceof Error ? e.message : String(e) };
  }
  const remoteTitleLcs = new Set(remote.map((p) => titleLc(p.title)));
  const report: string[] = [];
  let dirty = false;
  const markDirty = (msg: string): void => { report.push(msg); dirty = true; };

  // 結果不明の PUT を再送すると二重コミットになるため、詳細を取り直して本文一致で成功判定する。
  // filename は呼び出し側（action.filename）から受け取る。内容一致での逆引きはしない
  // （同一内容のファイルが複数あると別ファイルの state を誤更新するため）。
  // 401 は握り潰さず投げ直し、それ以外の失敗は「未確認（false）」にする。
  const confirmByRefetch = async (
    title: string, pageId: string | null, filename: string, canonical: string,
  ): Promise<boolean> => {
    let detail;
    try {
      detail = await client.getPage(title);
    } catch (e) {
      if (is401(e)) throw e;
      return false;
    }
    if (detail === null || (pageId !== null && detail.id !== pageId)) return false;
    if (detail.text !== canonical) return false;
    state.pages[detail.id] = { title: detail.title, filename, version: detail.version, contentHash: contentHash(canonical) };
    saveState(dir, state);
    return true;
  };

  try {
    for (const action of planPush({
      state,
      localFiles: new Map([...local].map(([n, f]) => [n, { firstLine: f.firstLine, contentHash: f.contentHash }])),
      remoteTitleLcs,
    })) {
      if (action.kind === 'skip-rename') {
        markDirty(`skipped (rename not supported; restore first line to "${action.stateTitle}"): ${action.filename}`);
        continue;
      }
      if (action.kind === 'skip-title-mismatch') {
        markDirty(`skipped (first line "${action.fileTitle}" does not match filename): ${action.filename}`);
        continue;
      }
      if (action.kind === 'skip-duplicate') {
        markDirty(`skipped (title already exists; run knot sync pull first): ${action.filename}`);
        continue;
      }
      const file = local.get(action.filename)!;
      const title = action.title;
      const baseVersion = action.kind === 'update' ? action.baseVersion : 0;
      const pageId = action.kind === 'update' ? action.pageId : null;
      let result;
      try {
        result = await client.putText(title, baseVersion, file.canonical);
      } catch (e) {
        if (is401(e)) throw e;
        // 通信断など結果不明: 再送せず本文一致で確認する（confirmByRefetch は 401 を投げ直す）
        const confirmed = await confirmByRefetch(title, pageId, action.filename, file.canonical);
        if (confirmed) report.push(`pushed (confirmed after error): ${action.filename}`);
        else markDirty(`failed: ${action.filename}`);
        continue;
      }
      if (result.kind === 'conflict' && force && pageId !== null) {
        // force-with-lease: 最新 version を取り直して 1 回だけ再試行する。
        // 401 は上位へ、それ以外の副次呼び出し失敗はこのページを conflict 扱いにして継続する。
        try {
          const detail = await client.getPage(title);
          if (detail !== null && detail.id === pageId) {
            result = await client.putText(title, detail.version, file.canonical);
          }
        } catch (e) {
          if (is401(e)) throw e;
          markDirty(`conflict (pull and merge, or push --force): ${action.filename}`);
          continue;
        }
      }
      if (result.kind === 'conflict') {
        markDirty(`conflict (pull and merge, or push --force): ${action.filename}`);
        continue;
      }
      if (pageId !== null) {
        state.pages[pageId] = { title, filename: action.filename, version: result.version, contentHash: file.contentHash };
        saveState(dir, state);
      } else {
        // 新規作成: PUT 応答は pageId を返さないため、詳細を取り直して記録する。
        // 401 は上位へ。再取得が失敗/null のときは pageId 未記録なので失敗扱いにする（pushed は記録成功時だけ）。
        let detail;
        try {
          detail = await client.getPage(title);
        } catch (e) {
          if (is401(e)) throw e;
          markDirty(`failed (created but state not recorded): ${action.filename}`);
          continue;
        }
        if (detail === null) {
          markDirty(`failed (created but state not recorded): ${action.filename}`);
          continue;
        }
        state.pages[detail.id] = { title: detail.title, filename: action.filename, version: detail.version, contentHash: contentHash(detail.text) };
        saveState(dir, state);
      }
      report.push(`pushed: ${action.filename}`);
    }
  } catch (e) {
    if (is401(e)) return { exitCode: 2, output: (e as SyncHttpError).message };
    throw e;
  }
  return { exitCode: dirty ? 1 : 0, output: report.length === 0 ? 'up to date' : report.join('\n') };
}
