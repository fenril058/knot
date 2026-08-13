import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from '../core/id.ts';
import { hashPassword } from '../server/password.ts';
import { generateApiToken } from '../server/apiToken.ts';
import { loadConfig as loadServerConfig } from '../server/config.ts';
import { openDatabase } from '../storage/db.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { importCosense } from '../storage/import.ts';
import { ATTACHMENT_IMPORT_TIMEOUT_MS } from '../storage/importAttachments.ts';
import { exportCosense, type ExportFormat } from '../storage/export.ts';
import { buildExportZip } from '../storage/exportZip.ts';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function openStorage(dataDir: string): SqliteStorage {
  return new SqliteStorage(openDatabase(join(dataDir, 'knot.db')));
}

const USER_NAME_RE = /^[a-z0-9_-]+$/;
const MIN_PASSWORD_LENGTH = 8;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export async function runServe(dataDir: string, port: number, hostname: string): Promise<never> {
  const { serve } = await import('@hono/node-server');
  const { createApp } = await import('../server/app.ts');
  const { loadConfig } = await import('../server/config.ts');
  const config = loadConfig(dataDir);
  if (config.secureCookie === 'auto') {
    config.secureCookie = !LOOPBACK_HOSTS.has(hostname);
  }
  if (!existsSync(join(dataDir, 'knot.db'))) {
    throw new CliError(`database not found in ${dataDir}; run knot init first`);
  }
  const storage = openStorage(dataDir);
  const app = createApp({ storage, config });
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`knot serving http://${hostname}:${info.port}/ (data: ${dataDir})`);
  });
  if (config.autoExportDir !== null) {
    const { startAutoExport } = await import('../server/autoExport.ts');
    startAutoExport({ storage, dataDir, config });
  }
  return new Promise<never>(() => {});
}

export async function runInit(dataDir: string): Promise<string> {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const storage = openStorage(dataDir);
  await storage.close();
  return `initialized ${dataDir}`;
}

export async function runImport(
  dataDir: string,
  projectName: string,
  file: string,
  onConflict: 'skip' | 'overwrite',
  deps: { fetchFn?: typeof fetch } = {},
): Promise<string> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const config = loadServerConfig(dataDir);
  const storage = openStorage(dataDir);
  try {
    const s = await importCosense(storage, data, {
      projectName,
      onConflict,
      attachments: {
        filesDir: join(dataDir, 'files'),
        fetchFn: deps.fetchFn ?? fetch,
        maxBytes: config.maxUploadBytes,
        timeoutMs: ATTACHMENT_IMPORT_TIMEOUT_MS,
      },
    });
    const attachmentSummary = s.attachments === undefined
      ? ''
      : `, attachments: ${s.attachments.created} created, ${s.attachments.reused} reused, ${s.attachments.failed} failed`;
    return `imported: ${s.created} created, ${s.overwritten} overwritten, ${s.skipped} skipped, ${s.users} users${attachmentSummary}`;
  } finally {
    await storage.close();
  }
}

export async function runExport(
  dataDir: string,
  projectName: string,
  format: ExportFormat,
  out: string | null,
  withFiles = false,
): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    const now = Math.floor(Date.now() / 1000);
    if (withFiles) {
      if (out === null) throw new CliError('--with-files requires --out');
      if (format === 'import') throw new CliError('--with-files cannot be used with --format import');
      const project = await storage.getProject(projectName);
      if (!project) throw new CliError(`unknown project: ${projectName}`);
      const zip = await buildExportZip(storage, dataDir, projectName, now);
      const [pages, attachments] = await Promise.all([
        storage.listPages(project.id),
        storage.listAttachments(project.id),
      ]);
      writeFileSync(out, zip);
      return `exported ${pages.length} pages and ${attachments.length} files to ${out}`;
    }
    const exp = await exportCosense(storage, projectName, format, now);
    const json = JSON.stringify(exp, null, 2);
    if (out === null) return json;
    writeFileSync(out, json);
    return `exported ${exp.pages.length} pages to ${out}`;
  } finally {
    await storage.close();
  }
}

export async function runReindex(dataDir: string, projectName: string | null): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    let projectId: string | undefined;
    if (projectName !== null) {
      const project = await storage.getProject(projectName);
      if (!project) throw new CliError(`unknown project: ${projectName}`);
      projectId = project.id;
    }
    const { pages } = await storage.reindex(projectId);
    return `reindexed ${pages} pages`;
  } finally {
    await storage.close();
  }
}

export async function runUserAdd(
  dataDir: string,
  name: string,
  displayName: string | null,
  isAdmin: boolean,
  password: string,
): Promise<string> {
  if (!USER_NAME_RE.test(name)) throw new CliError(`invalid user name: ${name} (must match ${USER_NAME_RE})`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new CliError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const now = Math.floor(Date.now() / 1000);
  const storage = openStorage(dataDir);
  try {
    const result = await storage.addUser(
      { id: ulid(now * 1000), name, displayName: displayName ?? name, passwordHash: hashPassword(password), isAdmin },
      now,
    );
    return result.kind === 'claimed'
      ? `claimed existing user ${name} (${result.id})`
      : `created user ${name} (${result.id})`;
  } finally {
    await storage.close();
  }
}

export async function runTokenAdd(dataDir: string, userName: string, label: string): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    const user = await storage.getUserByName(userName);
    if (user === null) throw new CliError(`unknown user: ${userName}`);
    if (user.passwordHash === null) throw new CliError(`user cannot log in: ${userName}`);
    const now = Math.floor(Date.now() / 1000);
    const { token, tokenHash } = generateApiToken();
    await storage.createApiToken({ id: ulid(now * 1000), userId: user.id, label, tokenHash, created: now });
    return token;
  } finally {
    await storage.close();
  }
}

export async function runTokenList(dataDir: string, userName: string): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    const user = await storage.getUserByName(userName);
    if (user === null) throw new CliError(`unknown user: ${userName}`);
    const tokens = await storage.listApiTokens(user.id);
    return tokens.map((token) => `${token.id}\t${token.label}\t${token.created}`).join('\n');
  } finally {
    await storage.close();
  }
}

export async function runTokenRevoke(dataDir: string, id: string): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    if (!(await storage.deleteApiToken(id))) throw new CliError(`unknown token: ${id}`);
    return `revoked token ${id}`;
  } finally {
    await storage.close();
  }
}
