import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { buildExportZip } from '../storage/exportZip.ts';
import type { Storage } from '../storage/types.ts';
import type { ServerConfig } from './config.ts';

type AutoExportOptions = { dir: string; keep: number };

function timestamp(now: number): string {
  return new Date(now * 1000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export async function runAutoExportOnce(
  storage: Storage,
  dataDir: string,
  opts: AutoExportOptions,
  now: number,
): Promise<{ written: string[]; pruned: string[] }> {
  const written: string[] = [];
  const pruned: string[] = [];
  const projects = await storage.listProjects();

  for (const project of projects) {
    let temporaryPath: string | undefined;
    try {
      const projectDir = join(opts.dir, project.name);
      await mkdir(projectDir, { recursive: true });
      const finalPath = join(projectDir, `${timestamp(now)}.zip`);
      temporaryPath = `${finalPath}.tmp`;
      const zip = await buildExportZip(storage, dataDir, project.name, now);
      await writeFile(temporaryPath, zip);
      await rename(temporaryPath, finalPath);
      written.push(finalPath);

      const generations = (await readdir(projectDir))
        .filter((name) => name.endsWith('.zip'))
        .toSorted((a, b) => b.localeCompare(a));
      for (const name of generations.slice(opts.keep)) {
        const path = join(projectDir, name);
        await unlink(path);
        pruned.push(path);
      }
    } catch (error) {
      if (temporaryPath !== undefined) {
        try {
          await unlink(temporaryPath);
        } catch (cleanupError) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`auto export cleanup failed for project ${project.name}:`, cleanupError);
          }
        }
      }
      console.error(`auto export failed for project ${project.name}:`, error);
    }
  }

  return { written, pruned };
}

export function startAutoExport(deps: {
  storage: Storage;
  dataDir: string;
  config: ServerConfig;
  now?: () => number;
}): { stop(): void } {
  const configuredDir = deps.config.autoExportDir;
  if (configuredDir === null) return { stop() {} };
  const dir = isAbsolute(configuredDir) ? configuredDir : resolve(deps.dataDir, configuredDir);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let running = false;

  const run = () => {
    // knot v1 は単一プロセス運用を前提とするため、プロセス間ロックは行わない。
    if (running) return;
    running = true;
    void runAutoExportOnce(deps.storage, deps.dataDir, { dir, keep: deps.config.autoExportKeep }, now())
      .catch((error: unknown) => console.error('auto export failed:', error))
      .finally(() => { running = false; });
  };

  run();
  const timer = setInterval(run, deps.config.autoExportIntervalHours * 60 * 60 * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
