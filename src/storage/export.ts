import type { CosenseExport, CosenseLine, CosensePage } from '../core/cosense.ts';
import { StorageError, type Storage } from './types.ts';

export type ExportFormat = 'full' | 'import';

export async function exportCosense(
  storage: Storage,
  projectName: string,
  format: ExportFormat,
  now: number,
): Promise<CosenseExport> {
  const project = await storage.getProject(projectName);
  if (!project) throw new StorageError(`unknown project: ${projectName}`);

  const pages: CosensePage[] = [];
  for (const meta of await storage.listPages(project.id)) {
    const page = await storage.getPageById(meta.id);
    if (!page) continue;
    const lines: CosenseLine[] =
      format === 'import'
        ? page.lines.map((l) => l.text)
        : page.lines.map((l) => ({ id: l.id, text: l.text, userId: l.userId, created: l.created, updated: l.updated }));
    pages.push({ id: page.id, title: page.title, created: page.created, updated: page.updated, lines });
  }

  const users = await storage.listUsersForProject(project.id);
  return {
    name: project.name,
    displayName: project.displayName,
    exported: now,
    users: users.map((u) => ({ id: u.id, name: u.name, displayName: u.displayName })),
    pages,
  };
}
