import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import {
  clearPendingPullRename,
  loadPendingPullRename,
  loadState,
  savePendingPullRename,
  saveState,
  type PageState,
  type PendingPullRename,
  type SyncState,
} from './state.ts';

export type SyncResult = { output: string; exitCode: 0 | 1 | 2 };
type FileDescriptorWriter = (fd: number, contents: string) => void;
export type SyncDeps = {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  writePullRenameContents?: FileDescriptorWriter;
};

const SYNC_USAGE = `usage:
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull   [--dir <dir>]
  knot sync push   [--dir <dir>] [--force]
  knot sync status [--dir <dir>] [--remote]`;

type LocalFile = { firstLine: string; contentHash: string; canonical: string };

// parseArgs に渡す options 定義と対応する値の型。Record<string, unknown> で受けると
// 取り出すたびにキャストが要り、型検査の裏付けを失う。
type SyncValues = {
  url?: string; project?: string; dir?: string; force?: boolean; remote?: boolean;
};

// 401 は runPush のどこで起きても即 exitCode 2。副次呼び出し内では投げ直してループ外の catch で拾う。
// 型述語にして、捕捉側で SyncHttpError へキャストし直さずに message を読めるようにする。
function is401(e: unknown): e is SyncHttpError {
  return e instanceof SyncHttpError && e.status === 401;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function pathSegmentsWithin(root: string, target: string): string[] | undefined {
  const path = relative(resolve(root), resolve(target));
  if (path === '') return [];
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep);
}

// root 自体は、利用者が symlink 経由で同期ディレクトリを指定する場合があるため検査対象外にする。
// その配下は各 path component を lstat し、末端だけでなく祖先の symlink も拒否する。
function hasSymlinkWithin(root: string, target: string): boolean {
  const segments = pathSegmentsWithin(root, target);
  if (segments === undefined) return true;
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
  }
  return false;
}

// recursive mkdir は既存の祖先 symlink を辿るため、各階層を検査してから個別に作る。
function ensureDirectoryWithoutSymlinks(root: string, target: string): boolean {
  const segments = pathSegmentsWithin(root, target);
  if (segments === undefined) return false;
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      continue;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    try {
      mkdirSync(current);
    } catch (error) {
      // lstat と mkdir の間に作られた場合は、直後の lstat で種類を検査する。
      if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

// O_NOFOLLOW 付きで末端を開き、lstat と write の間に末端を差し替える競合も拒否する。
function writeWithoutSymlinks(root: string, target: string, contents: string): boolean {
  if (hasSymlinkWithin(root, target)) return false;
  let fd: number;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) return false;
    throw error;
  }
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return true;
}

function writeAtomicallyWithoutSymlinks(
  root: string, target: string, contents: string,
  writeContents: FileDescriptorWriter = writeFileSync,
): boolean | 'exists' {
  if (hasSymlinkWithin(root, target)) return false;
  const tmp = join(dirname(target), `.knot-pull-rename-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    );
    writeContents(fd, contents);
    const completedFd = fd;
    fd = undefined;
    closeSync(completedFd);
    try {
      linkSync(tmp, target);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) return 'exists';
      throw error;
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

// サーバ由来の pageId をディレクトリ名として使う前に、単一の path segment であることを確認する。
// POSIX と Windows のどちらでも conflicts/ の外へ出られないよう、両方の区切り文字を拒否する。
function isSafePathSegment(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
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

async function runInit(positionals: string[], values: SyncValues): Promise<SyncResult> {
  const dir = positionals[0];
  const { url, project } = values;
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

async function runStatus(values: SyncValues, deps: SyncDeps): Promise<SyncResult> {
  const dir = values.dir ?? '.';
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
    // 既定値を置いて sub から undefined を外す。サブコマンド無しは default の usage エラーへ落ちる。
    const [sub = '', ...rest] = argv;
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
  writePullRenameContents?: FileDescriptorWriter;
};

function samePageState(left: PageState, right: PageState): boolean {
  return left.title === right.title
    && left.filename === right.filename
    && left.version === right.version
    && left.contentHash === right.contentHash;
}

function localContentHash(path: string): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return contentHash(canonicalizeText(readFileSync(path, 'utf8')));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function recoverPendingPullRename(dir: string, state: SyncState): string | undefined {
  const pending = loadPendingPullRename(dir);
  if (pending === undefined) return undefined;
  const current = state.pages[pending.pageId];
  const currentIsFrom = current !== undefined && samePageState(current, pending.from);
  const currentIsTo = current !== undefined && samePageState(current, pending.to);
  const targetClaimedByAnotherPage = Object.entries(state.pages).some(
    ([pageId, page]) => pageId !== pending.pageId && page.filename === pending.to.filename,
  );
  if (!isSafePathSegment(pending.from.filename)
    || !isSafePathSegment(pending.to.filename)
    || (!currentIsFrom && !currentIsTo)
    || targetClaimedByAnotherPage
    || localContentHash(join(dir, pending.to.filename)) !== pending.to.contentHash) {
    clearPendingPullRename(dir);
    return undefined;
  }

  if (currentIsFrom
    && pending.from.filename !== pending.to.filename
    && localContentHash(join(dir, pending.from.filename)) === pending.from.contentHash) {
    rmSync(join(dir, pending.from.filename), { force: true });
  }
  state.pages[pending.pageId] = pending.to;
  saveState(dir, state);
  clearPendingPullRename(dir);
  return `reconciled: ${pending.to.filename}`;
}

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
  if (!isSafePathSegment(pageId)) return warn(`skipped (invalid page id): ${filename}`);
  const cdir = join(ctx.dir, '.knot', 'conflicts', pageId);
  if (!ensureDirectoryWithoutSymlinks(ctx.dir, cdir)) {
    return warn(`skipped (refusing to write through symlink): ${filename}`);
  }
  const remotePath = join(cdir, 'remote.txt');
  if (!writeWithoutSymlinks(ctx.dir, remotePath, `${detail.text}\n`)) {
    return warn(`skipped (refusing to write through symlink): ${filename}`);
  }
  return warn(`conflict: ${filename} (remote copy in .knot/conflicts/${pageId}/)`);
}

function pullWrite(ctx: PullContext, pageId: string, detail: RemotePage): PageOutcome {
  // リネームなら新ファイルを書いてから旧ファイルを消す（write 失敗時に両方失わない）
  const prev = ctx.state.pages[pageId];
  const filename = prev !== undefined && titleLc(prev.title) === titleLc(detail.title)
    ? prev.filename
    : chooseFilename(ctx.dir, ctx.state, pageId, detail.title);
  const next: PageState = {
    title: detail.title, filename, version: detail.version, contentHash: contentHash(detail.text),
  };
  const pending: PendingPullRename | undefined = prev !== undefined && prev.filename !== filename
    ? { pageId, from: prev, to: next }
    : undefined;
  // ファイル操作より先に記録し、どの段階で停止しても次回 pull で同じ新ファイルを追跡し直せるようにする。
  if (pending !== undefined) savePendingPullRename(ctx.dir, pending);
  const targetPath = join(ctx.dir, filename);
  const written = pending === undefined
    ? writeWithoutSymlinks(ctx.dir, targetPath, `${detail.text}\n`)
    : writeAtomicallyWithoutSymlinks(ctx.dir, targetPath, `${detail.text}\n`, ctx.writePullRenameContents);
  if (written === 'exists') {
    clearPendingPullRename(ctx.dir);
    return warn(`skipped (filename appeared during pull): ${filename}`);
  }
  if (!written) {
    if (pending !== undefined) clearPendingPullRename(ctx.dir);
    return warn(`skipped (refusing to write through symlink): ${filename}`);
  }
  if (prev !== undefined && prev.filename !== filename) rmSync(join(ctx.dir, prev.filename), { force: true });
  ctx.state.pages[pageId] = next;
  saveState(ctx.dir, ctx.state);
  if (pending !== undefined) clearPendingPullRename(ctx.dir);
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
    if (is401(e)) return { outcome: { kind: 'abort', message: e.message } };
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

async function runPull(values: SyncValues, deps: SyncDeps): Promise<SyncResult> {
  const dir = values.dir ?? '.';
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const remote = await listRemote(client);
  if (!Array.isArray(remote)) return remote;
  const recovered = recoverPendingPullRename(dir, state);
  const local = readLocalFiles(dir);
  const ctx: PullContext = {
    dir, client, state, local, remoteById: new Map(remote.map((p) => [p.id, p])),
    writePullRenameContents: deps.writePullRenameContents,
  };
  const localHashes = new Map([...local].map(([name, f]) => [name, f.contentHash]));
  const result = await foldOutcomes(planPull({ state, remote, localHashes }), (a) => applyPullAction(ctx, a));
  if (recovered === undefined || result.exitCode === 2) return result;
  return { ...result, output: result.output === 'up to date' ? recovered : `${recovered}\n${result.output}` };
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
// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かないことで、分岐漏れを型エラーにしている
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
    if (is401(e)) return { kind: 'abort', message: e.message };
    throw e;
  }
}

async function runPush(values: SyncValues, deps: SyncDeps): Promise<SyncResult> {
  const dir = values.dir ?? '.';
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
