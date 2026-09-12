import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const source = resolve(process.argv[2] ?? join(repositoryRoot, 'public'));
const destination = resolve(process.argv[3] ?? join(repositoryRoot, '.worker-assets'));

export async function prepareWorkerAssets(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(destinationDirectory, { recursive: true });
  await cp(sourceDirectory, join(destinationDirectory, 'assets'), { recursive: true });
}

if (import.meta.main) await prepareWorkerAssets(source, destination);
