import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError } from '../commands.ts';
import { canonicalizeText, contentHash } from './canonical.ts';
import { loadSyncConfig, normalizeBaseUrl, writeSyncConfig } from './config.ts';
import { loadState } from './state.ts';

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

// Task 9 で pull と共に実装する（それまでは未実装）
async function remoteStatusLines(_dir: string, _deps: SyncDeps): Promise<string[]> {
  throw new CliError('status --remote is not implemented yet');
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

// Task 9 / Task 10 で実装する
async function runPull(_values: Record<string, unknown>, _deps: SyncDeps): Promise<SyncResult> {
  throw new CliError('pull is not implemented yet');
}
async function runPush(_values: Record<string, unknown>, _deps: SyncDeps): Promise<SyncResult> {
  throw new CliError('push is not implemented yet');
}
