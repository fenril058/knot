import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { titleLc } from '../../core/title.ts';
import { CliError } from '../commands.ts';
import { canonicalizeText, contentHash } from './canonical.ts';
import {
  makeSyncClient, SyncHttpError,
  type PageEntry, type PutTextResult, type RemotePage, type SyncClient,
} from './client.ts';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from './config.ts';
import { planPull, planPush, type PullAction, type PushAction } from './decisions.ts';
import { titleToFilename } from './filenames.ts';
import { loadState, saveState, type SyncState } from './state.ts';

export type SyncResult = { output: string; exitCode: 0 | 1 | 2 };
export type SyncDeps = { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv };

const SYNC_USAGE = `usage:
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull   [--dir <dir>]
  knot sync push   [--dir <dir>] [--force]
  knot sync status [--dir <dir>] [--remote]`;

type LocalFile = { firstLine: string; contentHash: string; canonical: string };

// 401 は runPush のどこで起きても即 exitCode 2。副次呼び出し内では投げ直してループ外の catch で拾う。
function is401(e: unknown): boolean {
  return e instanceof SyncHttpError && e.status === 401;
}

// 書き込み先が symlink かどうかを無条件の lstat で判定する。
// existsSync は symlink を辿るため、ダングリング symlink（リンク先が存在しない）では
// false を返してガードを素通りさせてしまう。lstat は辿らないので symlink 自体を検出できる。
// ENOENT（何も無い）は false = 通常の新規書き込み可、とする。
function isSymlinkAt(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// 同期ディレクトリ直下の .txt を走査する（.knot/ とサブディレクトリは対象外）
function readLocalFiles(dir: string): Map<string, LocalFile> {
  const out = new Map<string, LocalFile>();
  const names = readdirSync(dir).toSorted();
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const path = join(dir, name);
    const st = lstatSync(path);
    // symlink はローカルディレクトリ外への読み書きに使われうるため対象外にする（statSync だと辿ってしまう）
    if (!st.isFile() || st.isSymbolicLink()) continue;
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
    try {
      lines.push(...(await remoteStatusLines(dir, deps)));
    } catch (e) {
      // SyncHttpError（401 含む）・transport 失敗のどちらも exitCode 2 で終える
      // （runSync は CliError しか拾わないため、ここで拾わないとクラッシュする）
      return { exitCode: 2, output: e instanceof Error ? e.message : String(e) };
    }
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

// 1 ページ分の処理結果。ok は成功、warn は「続行するが exitCode 1」、
// abort はコマンド全体を exitCode 2 で終える（トークン失効など per-page で握り潰せない失敗）。
type PageOutcome =
  | { kind: 'ok'; message: string }
  | { kind: 'warn'; message: string }
  | { kind: 'abort'; message: string };

const ok = (message: string): PageOutcome => ({ kind: 'ok', message });
const warn = (message: string): PageOutcome => ({ kind: 'warn', message });

// action を 1 件ずつ適用し、結果を report と exitCode へ畳む。
// abort が出た時点で打ち切り、それまでの report は捨てて失敗理由だけを返す。
async function foldOutcomes<A>(actions: A[], apply: (action: A) => Promise<PageOutcome>): Promise<SyncResult> {
  const report: string[] = [];
  let dirty = false;
  for (const action of actions) {
    const outcome = await apply(action);
    if (outcome.kind === 'abort') return { exitCode: 2, output: outcome.message };
    report.push(outcome.message);
    if (outcome.kind === 'warn') dirty = true;
  }
  return { exitCode: dirty ? 1 : 0, output: report.length === 0 ? 'up to date' : report.join('\n') };
}

// listPages は SyncHttpError（サーバ応答由来）だけでなく transport 失敗（接続拒否・DNS・
// タイムアウト等で fetch が Response を返す前に reject する）でも投げる。
// どちらもクラッシュさせず exitCode 2 で終える。
async function listRemote(client: SyncClient): Promise<PageEntry[] | SyncResult> {
  try {
    return await client.listPages();
  } catch (e) {
    return { exitCode: 2, output: e instanceof Error ? e.message : String(e) };
  }
}

type PullContext = {
  dir: string;
  client: SyncClient;
  state: SyncState;
  local: Map<string, LocalFile>;
  remoteById: Map<string, PageEntry>;
};

function pullDeleteLocal(ctx: PullContext, pageId: string): PageOutcome {
  const st = ctx.state.pages[pageId]!;
  rmSync(join(ctx.dir, st.filename), { force: true });
  delete ctx.state.pages[pageId];
  saveState(ctx.dir, ctx.state);
  return ok(`deleted: ${st.filename}`);
}

// 競合したページのリモート版を .knot/conflicts/<pageId>/remote.txt へ隔離する
function pullConflict(ctx: PullContext, pageId: string, detail: RemotePage): PageOutcome {
  const filename = ctx.state.pages[pageId]!.filename;
  // クラッシュ等で直前の pull の state 保存だけが失われていた場合、ローカルは既にリモートと
  // 同じ内容になっていることがある。その場合は偽の競合として state を追いつかせるだけにする。
  const remoteHash = contentHash(canonicalizeText(detail.text));
  if (ctx.local.get(filename)?.contentHash === remoteHash) {
    ctx.state.pages[pageId] = { title: detail.title, filename, version: detail.version, contentHash: remoteHash };
    saveState(ctx.dir, ctx.state);
    return ok(`reconciled: ${filename}`);
  }
  const cdir = join(ctx.dir, '.knot', 'conflicts', pageId);
  mkdirSync(cdir, { recursive: true });
  const remotePath = join(cdir, 'remote.txt');
  // symlink を辿って隔離ディレクトリ外へ書き込まない
  if (isSymlinkAt(remotePath)) return warn(`skipped (refusing to write through symlink): ${filename}`);
  writeFileSync(remotePath, `${detail.text}\n`);
  return warn(`conflict: ${filename} (remote copy in .knot/conflicts/${pageId}/)`);
}

function pullWrite(ctx: PullContext, pageId: string, detail: RemotePage): PageOutcome {
  // リネームなら新ファイルを書いてから旧ファイルを消す（write 失敗時に両方失わない）
  const prev = ctx.state.pages[pageId];
  const filename = prev !== undefined && titleLc(prev.title) === titleLc(detail.title)
    ? prev.filename
    : chooseFilename(ctx.dir, ctx.state, pageId, detail.title);
  const targetPath = join(ctx.dir, filename);
  // symlink を辿って同期ディレクトリ外へ書き込まない
  if (isSymlinkAt(targetPath)) return warn(`skipped (refusing to write through symlink): ${filename}`);
  writeFileSync(targetPath, `${detail.text}\n`);
  if (prev !== undefined && prev.filename !== filename) rmSync(join(ctx.dir, prev.filename), { force: true });
  ctx.state.pages[pageId] = {
    title: detail.title, filename, version: detail.version, contentHash: contentHash(detail.text),
  };
  saveState(ctx.dir, ctx.state);
  return ok(`pulled: ${filename}`);
}

// write / conflict は詳細を取得し、id の一致を必ず検証する
// （削除済みページのタイトルは再利用されうるため、タイトル解決が別ページを返す危険がある）
async function fetchPullDetail(
  ctx: PullContext, pageId: string, title: string,
): Promise<{ detail: RemotePage } | { outcome: PageOutcome }> {
  let detail;
  try {
    detail = await ctx.client.getPage(title);
  } catch (e) {
    // 401 は runPush と同様に即座に exitCode 2 で終える（トークン失効を per-page skip で握り潰さない）。
    if (is401(e)) return { outcome: { kind: 'abort', message: (e as SyncHttpError).message } };
    // 401 以外（transport 失敗: 接続拒否・DNS・タイムアウト等）はそのページだけスキップし、
    // 他ページの処理は続行する（state/ファイルは不変）。
    return { outcome: warn(`skipped (fetch failed): ${title}`) };
  }
  if (detail === null || detail.id !== ctx.remoteById.get(pageId)!.id) {
    return { outcome: warn(`skipped (page moved during pull): ${title}`) };
  }
  return { detail };
}

async function applyPullAction(ctx: PullContext, action: PullAction): Promise<PageOutcome> {
  if (action.kind === 'delete-local') return pullDeleteLocal(ctx, action.pageId);
  if (action.kind === 'keep-deleted') {
    return warn(`kept (deleted on remote, locally modified): ${ctx.state.pages[action.pageId]!.filename}`);
  }
  const fetched = await fetchPullDetail(ctx, action.pageId, action.title);
  if ('outcome' in fetched) return fetched.outcome;
  return action.kind === 'conflict'
    ? pullConflict(ctx, action.pageId, fetched.detail)
    : pullWrite(ctx, action.pageId, fetched.detail);
}

async function runPull(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  const remote = await listRemote(client);
  if (!Array.isArray(remote)) return remote;
  const ctx: PullContext = { dir, client, state, local, remoteById: new Map(remote.map((p) => [p.id, p])) };
  const localHashes = new Map([...local].map(([name, f]) => [name, f.contentHash]));
  return await foldOutcomes(planPull({ state, remote, localHashes }), (a) => applyPullAction(ctx, a));
}

type PushContext = {
  dir: string;
  client: SyncClient;
  state: SyncState;
  local: Map<string, LocalFile>;
  force: boolean;
};

// PUT 対象 1 ページ分の情報。pageId が null なら新規作成（リモートに対応ページがまだ無い）。
type PushTarget = {
  title: string;
  pageId: string | null;
  filename: string;
  canonical: string;
  contentHash: string;
};

type PushWriteAction = Extract<PushAction, { kind: 'update' | 'create' }>;
type PushSkipAction = Exclude<PushAction, PushWriteAction>;

function conflictOutcome(filename: string): PageOutcome {
  return warn(`conflict (pull and merge, or push --force): ${filename}`);
}

// PUT の応答喪失（通信断など結果不明）の共通処理。再送すると二重コミットになるため、
// 詳細を取り直して本文一致で成功判定し、確認できたときだけ state を記録する。
// filename は呼び出し側（action.filename）から受け取る。内容一致での逆引きはしない
// （同一内容のファイルが複数あると別ファイルの state を誤更新するため）。
// 401 は握り潰さず投げ直し、それ以外の失敗は「未確認」として failed を報告する。
async function settleLostResponse(ctx: PushContext, target: PushTarget): Promise<PageOutcome> {
  let detail;
  try {
    detail = await ctx.client.getPage(target.title);
  } catch (e) {
    if (is401(e)) throw e;
    detail = null;
  }
  if (detail === null || (target.pageId !== null && detail.id !== target.pageId) || detail.text !== target.canonical) {
    return warn(`failed: ${target.filename}`);
  }
  ctx.state.pages[detail.id] = {
    title: detail.title, filename: target.filename, version: detail.version, contentHash: contentHash(target.canonical),
  };
  saveState(ctx.dir, ctx.state);
  return ok(`pushed (confirmed after error): ${target.filename}`);
}

// force-with-lease: 最新 version を取り直して 1 回だけ再試行する。
// detail 取得に失敗した場合はこのページを conflict 扱いにして継続する。
async function retryWithLease(
  ctx: PushContext, target: PushTarget,
): Promise<{ result: PutTextResult } | { outcome: PageOutcome }> {
  let detail;
  try {
    detail = await ctx.client.getPage(target.title);
  } catch (e) {
    if (is401(e)) throw e;
    return { outcome: conflictOutcome(target.filename) };
  }
  if (detail === null || detail.id !== target.pageId) return { result: { kind: 'conflict' } };
  try {
    return { result: await ctx.client.putText(target.title, detail.version, target.canonical) };
  } catch (e) {
    if (is401(e)) throw e;
    // 再試行 PUT の通信断: サーバには届いたが応答が失われた可能性があるため、
    // 再送はせず本文一致で確認する（主 PUT の応答喪失パスと同じ扱い）。
    return { outcome: await settleLostResponse(ctx, target) };
  }
}

// 直前の push の state 保存だけが失われていた可能性がある: リモートが既にローカルと
// 一致していれば偽の競合として state を追いつかせる（本物の競合はそのまま報告する）。
async function settleConflict(ctx: PushContext, target: PushTarget): Promise<PageOutcome> {
  if (target.pageId === null) return conflictOutcome(target.filename);
  let detail;
  try {
    detail = await ctx.client.getPage(target.title);
  } catch (e) {
    if (is401(e)) throw e;
    // 再取得の失敗は通常の conflict 報告へフォールバックする
    return conflictOutcome(target.filename);
  }
  if (detail === null || detail.id !== target.pageId
    || contentHash(canonicalizeText(detail.text)) !== target.contentHash) {
    return conflictOutcome(target.filename);
  }
  ctx.state.pages[target.pageId] = {
    title: detail.title, filename: target.filename, version: detail.version, contentHash: target.contentHash,
  };
  saveState(ctx.dir, ctx.state);
  return ok(`reconciled: ${target.filename}`);
}

// PUT 成功後に state を記録する。新規作成は PUT 応答が pageId を返さないため詳細を取り直す。
// 401 は上位へ。再取得が失敗/null のときは pageId 未記録なので失敗扱いにする（pushed は記録成功時だけ）。
async function recordPushed(ctx: PushContext, target: PushTarget, version: number): Promise<PageOutcome> {
  if (target.pageId !== null) {
    ctx.state.pages[target.pageId] = {
      title: target.title, filename: target.filename, version, contentHash: target.contentHash,
    };
    saveState(ctx.dir, ctx.state);
    return ok(`pushed: ${target.filename}`);
  }
  let detail;
  try {
    detail = await ctx.client.getPage(target.title);
  } catch (e) {
    if (is401(e)) throw e;
    return warn(`failed (created but state not recorded): ${target.filename}`);
  }
  if (detail === null) return warn(`failed (created but state not recorded): ${target.filename}`);
  ctx.state.pages[detail.id] = {
    title: detail.title, filename: target.filename, version: detail.version, contentHash: contentHash(detail.text),
  };
  saveState(ctx.dir, ctx.state);
  return ok(`pushed: ${target.filename}`);
}

async function pushPage(ctx: PushContext, action: PushWriteAction): Promise<PageOutcome> {
  const file = ctx.local.get(action.filename)!;
  const target: PushTarget = {
    title: action.title,
    pageId: action.kind === 'update' ? action.pageId : null,
    filename: action.filename,
    canonical: file.canonical,
    contentHash: file.contentHash,
  };
  let result;
  try {
    result = await ctx.client.putText(target.title, action.kind === 'update' ? action.baseVersion : 0, target.canonical);
  } catch (e) {
    if (is401(e)) throw e;
    // 通信断など結果不明: 再送せず本文一致で確認する
    return await settleLostResponse(ctx, target);
  }
  if (result.kind === 'conflict' && ctx.force && target.pageId !== null) {
    const retried = await retryWithLease(ctx, target);
    if ('outcome' in retried) return retried.outcome;
    result = retried.result;
  }
  if (result.kind === 'conflict') return await settleConflict(ctx, target);
  return await recordPushed(ctx, target, result.version);
}

// PushAction に kind を足したときは、この switch か applyPushAction のどちらかが
// コンパイルエラーになる（網羅していない分岐は戻り値が undefined になり型に合わない）。
function pushSkipOutcome(action: PushSkipAction): PageOutcome {
  switch (action.kind) {
    case 'skip-rename':
      return warn(`skipped (rename not supported; restore first line to "${action.stateTitle}"): ${action.filename}`);
    case 'skip-title-mismatch':
      return warn(`skipped (first line "${action.fileTitle}" does not match filename): ${action.filename}`);
    case 'skip-duplicate':
      return warn(`skipped (title already exists; run knot sync pull first): ${action.filename}`);
  }
}

async function applyPushAction(ctx: PushContext, action: PushAction): Promise<PageOutcome> {
  if (action.kind !== 'update' && action.kind !== 'create') return pushSkipOutcome(action);
  try {
    return await pushPage(ctx, action);
  } catch (e) {
    // 401 は runPush のどこで起きても即 exitCode 2（副次呼び出しから投げ直されたものをここで拾う）
    if (is401(e)) return { kind: 'abort', message: (e as SyncHttpError).message };
    throw e;
  }
}

async function runPush(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  const remote = await listRemote(client);
  if (!Array.isArray(remote)) return remote;
  const ctx: PushContext = { dir, client, state, local, force: values.force === true };
  const actions = planPush({
    state,
    localFiles: new Map([...local].map(([n, f]) => [n, { firstLine: f.firstLine, contentHash: f.contentHash }])),
    remoteTitleLcs: new Set(remote.map((p) => titleLc(p.title))),
  });
  return await foldOutcomes(actions, (a) => applyPushAction(ctx, a));
}
