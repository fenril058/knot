import { getPlatformProxy } from 'wrangler';
import { D1Storage, type D1Binding } from '../src/storage/d1.ts';

const args = process.argv.slice(2);
let remote = false;
let configPath = 'wrangler.jsonc';
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (argument === '--remote') {
    remote = true;
  } else if (argument === '--config') {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('--config requires a path');
    configPath = value;
    index += 1;
  } else {
    throw new Error(`unknown argument: ${argument}`);
  }
}

// getPlatformProxy reads the complete Worker config, but bootstrap only uses DB.
process.env.KNOT_ACCESS_CONFIG ??= '{}';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const platform = await getPlatformProxy<{ DB: D1Binding }>({
  configPath,
  persist: true,
  remoteBindings: remote,
});

try {
  const storage = new D1Storage(platform.env.DB);
  const result = await storage.addAccessAccount({
    id: required('KNOT_BOOTSTRAP_ACCOUNT_ID'),
    actor: {
      id: required('KNOT_BOOTSTRAP_ACTOR_ID'),
      name: required('KNOT_BOOTSTRAP_ACCOUNT_NAME'),
      displayName: required('KNOT_BOOTSTRAP_DISPLAY_NAME'),
    },
    name: required('KNOT_BOOTSTRAP_ACCOUNT_NAME'),
    email: required('KNOT_BOOTSTRAP_EMAIL'),
  }, Math.floor(Date.now() / 1000));
  console.log(JSON.stringify({ target: remote ? 'remote' : 'local', ...result }));
} finally {
  await platform.dispose();
}
