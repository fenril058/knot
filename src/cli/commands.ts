import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from '../core/id.ts';
import { hashPassword } from '../server/password.ts';
import { openDatabase } from '../storage/db.ts';
import { SqliteStorage } from '../storage/sqlite.ts';
import { importCosense } from '../storage/import.ts';
import { exportCosense, type ExportFormat } from '../storage/export.ts';

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
): Promise<string> {
  const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const storage = openStorage(dataDir);
  try {
    const s = await importCosense(storage, data, { projectName, onConflict });
    return `imported: ${s.created} created, ${s.overwritten} overwritten, ${s.skipped} skipped, ${s.users} users`;
  } finally {
    await storage.close();
  }
}

export async function runExport(
  dataDir: string,
  projectName: string,
  format: ExportFormat,
  out: string | null,
): Promise<string> {
  const storage = openStorage(dataDir);
  try {
    const exp = await exportCosense(storage, projectName, format, Math.floor(Date.now() / 1000));
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
