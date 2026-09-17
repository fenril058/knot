import { getPlatformProxy } from 'wrangler';
import { D1Storage, type D1Binding } from '../src/storage/d1.ts';

const args = process.argv.slice(2);
let remote = false;
let configPath = 'wrangler.jsonc';
let persistTo: string | undefined;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (argument === '--remote') {
    remote = true;
  } else if (argument === '--config' || argument === '--persist-to') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`);
    if (argument === '--config') configPath = value;
    else persistTo = value;
    index += 1;
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}
if (remote && persistTo !== undefined) throw new Error('--persist-to only applies to local D1');

// Suppress Wrangler's missing-secret warning; reindex only uses DB.
process.env.KNOT_ACCESS_CONFIG ??= '{}';
const platform = await getPlatformProxy<{ DB: D1Binding }>({
  configPath,
  persist: persistTo === undefined ? true : { path: `${persistTo}/v3` },
  remoteBindings: remote,
});
try {
  const result = await new D1Storage(platform.env.DB).reindex();
  console.log(JSON.stringify({ target: remote ? 'remote' : 'local', ...result }));
} finally {
  await platform.dispose();
}
