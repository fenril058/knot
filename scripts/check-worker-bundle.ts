import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const forbiddenDependencies = [
  'node:sqlite',
  'node:fs',
  'node:path',
  'node:http',
  'node:https',
  'node:url',
  '@hono/node-server',
  'SqliteStorage',
  'DatabaseSync',
];

async function javascriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return extname(path) === '.js' || extname(path) === '.mjs' ? [path] : [];
  }));
  return nested.flat();
}

const outputDirectory = resolve(process.argv[2] ?? 'dist/worker');
const files = await javascriptFiles(outputDirectory);
if (files.length === 0) throw new Error(`no Worker JavaScript found in ${outputDirectory}`);

for (const file of files) {
  const bundle = await readFile(file, 'utf8');
  for (const dependency of forbiddenDependencies) {
    if (bundle.includes(dependency)) throw new Error(`${file} contains forbidden dependency ${dependency}`);
  }
}
