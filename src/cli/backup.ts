import { backup } from 'node:sqlite';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openDatabase } from '../storage/db.ts';
import { CliError } from './commands.ts';

function realpathThroughAncestor(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validatePaths(dataDir: string, outDir: string): void {
  const realDataDir = realpathThroughAncestor(dataDir);
  const realOutDir = realpathThroughAncestor(outDir);
  if (contains(realDataDir, realOutDir) || contains(realOutDir, realDataDir)) {
    throw new CliError('data directory and backup directory must not be the same or contain one another');
  }
  if (pathExists(outDir)) throw new CliError(`backup destination already exists: ${outDir}`);
}

export async function runBackup(dataDir: string, outDir: string): Promise<string> {
  validatePaths(dataDir, outDir);
  const outParent = dirname(resolve(outDir));
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(outParent, '.knot-backup-'));

    // Files are copied before the database snapshot so every attachment visible
    // in the later snapshot should already have its file in the backup.
    // A concurrent upload can still make verification fail; rerunning is safe.
    cpSync(join(dataDir, 'files'), join(tempDir, 'files'), { recursive: true });
    const configPath = join(dataDir, 'config.json');
    if (existsSync(configPath)) cpSync(configPath, join(tempDir, 'config.json'));

    const sourceDb = openDatabase(join(dataDir, 'knot.db'));
    try {
      await backup(sourceDb, join(tempDir, 'knot.db'));
    } finally {
      sourceDb.close();
    }

    const snapshotDb = openDatabase(join(tempDir, 'knot.db'));
    let attachmentIds: string[];
    try {
      attachmentIds = (snapshotDb.prepare('SELECT id FROM attachments ORDER BY id').all() as { id: string }[])
        .map((row) => row.id);
    } finally {
      snapshotDb.close();
    }
    const missing = attachmentIds.filter((id) => !existsSync(join(tempDir!, 'files', id)));
    if (missing.length > 0) throw new CliError(`backup missing attachment files: ${missing.join(', ')}`);

    renameSync(tempDir, outDir);
    tempDir = undefined;
    return `backed up to ${outDir} (${attachmentIds.length} attachments verified)`;
  } catch (error) {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
    if (error instanceof CliError) throw error;
    throw new CliError(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
