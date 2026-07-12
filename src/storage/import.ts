import { normalizeLines, parseExportFile } from '../core/cosense.ts';
import { ulid } from '../core/id.ts';
import type { ImportLine, Storage } from './types.ts';

export const IMPORTER_USER_NAME = 'knot-import';

export type ImportOptions = {
  projectName: string;
  onConflict?: 'skip' | 'overwrite';
  now?: number;
};

export type ImportSummary = { created: number; overwritten: number; skipped: number; users: number };

export async function importCosense(storage: Storage, data: unknown, options: ImportOptions): Promise<ImportSummary> {
  const exp = parseExportFile(data);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const onConflict = options.onConflict ?? 'skip';
  const project = await storage.ensureProject(options.projectName, now);

  const importerId = await storage.upsertDisplayUser(
    { id: ulid(now * 1000), name: IMPORTER_USER_NAME, displayName: IMPORTER_USER_NAME },
    now,
  );
  const users = exp.users ?? [];
  for (const user of users) {
    await storage.upsertDisplayUser({ id: user.id, name: user.name, displayName: user.displayName ?? user.name }, now);
  }

  const summary: ImportSummary = { created: 0, overwritten: 0, skipped: 0, users: users.length };
  for (const page of exp.pages) {
    const lines: ImportLine[] = normalizeLines(page).map((line) => ({
      id: line.id ?? ulid(now * 1000),
      text: line.text,
      created: line.created ?? now,
      updated: line.updated ?? now,
      userId: line.userId ?? importerId,
    }));
    const result = await storage.importPage({
      projectId: project.id,
      page: {
        id: page.id ?? ulid(now * 1000),
        title: page.title,
        created: page.created ?? now,
        updated: page.updated ?? now,
      },
      lines,
      userId: importerId,
      now,
      onConflict,
    });
    summary[result.kind]++;
  }
  return summary;
}
