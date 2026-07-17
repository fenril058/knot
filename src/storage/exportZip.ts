import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportCosense } from './export.ts';
import { StorageError, type Storage } from './types.ts';
import { createZip, type ZipEntry } from './zip.ts';

export async function buildExportZip(
  storage: Storage,
  dataDir: string,
  projectName: string,
  now: number,
): Promise<Buffer> {
  const exp = await exportCosense(storage, projectName, 'full', now);
  const project = await storage.getProject(projectName);
  if (!project) throw new StorageError(`unknown project: ${projectName}`);

  const entries: ZipEntry[] = [
    { name: `${projectName}.json`, data: Buffer.from(JSON.stringify(exp, null, 2)), mtime: now },
  ];
  for (const attachment of await storage.listAttachments(project.id)) {
    let data: Buffer;
    try {
      data = await readFile(join(dataDir, 'files', attachment.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageError(`attachment file not found: ${attachment.id}`);
      }
      throw error;
    }
    entries.push({ name: `files/${attachment.id}`, data, mtime: attachment.created });
  }
  return createZip(entries);
}
