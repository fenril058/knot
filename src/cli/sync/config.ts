import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../commands.ts';

export type SyncConfig = { url: string; project: string };

export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(`invalid url: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`url must be http(s): ${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CliError('userinfo in url is not allowed');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new CliError('url must not contain query or fragment');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

export function writeSyncConfig(dir: string, config: SyncConfig): void {
  mkdirSync(join(dir, '.knot'), { recursive: true });
  writeFileSync(join(dir, '.knot', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function loadSyncConfig(dir: string): SyncConfig {
  const path = join(dir, '.knot', 'config.json');
  if (!existsSync(path)) throw new CliError(`not a sync directory (missing ${join('.knot', 'config.json')}); run knot sync init first`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SyncConfig>;
  if (typeof parsed.url !== 'string' || typeof parsed.project !== 'string') {
    throw new CliError('invalid .knot/config.json: url and project required');
  }
  return { url: parsed.url, project: parsed.project };
}

export function resolveToken(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KNOT_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const path = join(dir, '.knot', 'token');
  if (!existsSync(path)) {
    throw new CliError('no API token: set KNOT_TOKEN or write .knot/token (create one with: knot token add)');
  }
  return readFileSync(path, 'utf8').trim();
}
