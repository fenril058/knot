import { backup } from 'node:sqlite';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openDatabase } from '../storage/db.ts';
import { CliError } from './commands.ts';

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

function validatePaths(dataDir: string, outDir: string): { realData: string; realOut: string } {
  let realData: string;
  let realOut: string;
  try {
    realData = realpathSync(resolve(dataDir));
    const resolvedOut = resolve(outDir);
    realOut = join(realpathSync(dirname(resolvedOut)), basename(resolvedOut));
  } catch (error) {
    throw new CliError(`backup path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (contains(realData, realOut) || contains(realOut, realData)) {
    throw new CliError('data directory and backup directory must not be the same or contain one another');
  }
  if (pathExists(realOut)) throw new CliError(`backup destination already exists: ${realOut}`);
  return { realData, realOut };
}

export async function runBackup(dataDir: string, outDir: string): Promise<string> {
  const { realData, realOut } = validatePaths(dataDir, outDir);
  const outParent = dirname(realOut);
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(outParent, '.knot-backup-'));

    // Files are copied before the database snapshot so every attachment visible
    // in the later snapshot should already have its file in the backup.
    // A concurrent upload can still make verification fail; rerunning is safe.
    // Symlinked attachments are dereferenced so the backup remains self-contained.
    // cpSync の dereference は入れ子の symlink をリンクのまま残すため使えない。
    // files/ は files/<attachment.id> のフラット構造なので copyFileSync（常に実体を開く）で写す。
    const filesSrc = join(realData, 'files');
    const filesDest = join(tempDir, 'files');
    mkdirSync(filesDest);
    for (const name of readdirSync(filesSrc)) {
      copyFileSync(join(filesSrc, name), join(filesDest, name));
    }
    const configPath = join(realData, 'config.json');
    if (existsSync(configPath)) cpSync(configPath, join(tempDir, 'config.json'));

    const sourceDb = openDatabase(join(realData, 'knot.db'));
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

    renameSync(tempDir, realOut);
    tempDir = undefined;
    return `backed up to ${realOut} (${attachmentIds.length} attachments verified)`;
  } catch (error) {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
    if (error instanceof CliError) throw error;
    throw new CliError(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
