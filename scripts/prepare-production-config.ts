import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const databaseId = process.env.KNOT_D1_DATABASE_ID;
const publicRoute = process.argv[2] === '--enable-workers-dev';

if (process.argv.length > (publicRoute ? 3 : 2)) throw new Error('unknown argument');
if (databaseId === undefined || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(databaseId)) {
  throw new Error('KNOT_D1_DATABASE_ID must be the production D1 UUID');
}

const source = await readFile(resolve(repositoryRoot, 'wrangler.jsonc'), 'utf8');
// The tracked config uses standalone JSONC comments, so removing comment lines preserves string values.
const parsed: unknown = JSON.parse(source.replace(/^\s*\/\/.*$/gmu, ''));
if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('wrangler.jsonc is invalid');

const config = {
  ...parsed,
  name: 'knot-dogfood',
  workers_dev: publicRoute,
  preview_urls: false,
  d1_databases: [{
    binding: 'DB',
    database_name: 'knot-dogfood',
    database_id: databaseId,
    migrations_dir: 'src/storage/migrations/d1',
    remote: true,
  }],
};

const destination = resolve(repositoryRoot, '.wrangler.production.jsonc');
await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`${destination}: workers.dev ${publicRoute ? 'enabled' : 'disabled'}`);
