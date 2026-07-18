#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  CliError,
  runExport,
  runImport,
  runInit,
  runReindex,
  runServe,
  runTokenAdd,
  runTokenList,
  runTokenRevoke,
  runUserAdd,
} from './commands.ts';
import { runBackup } from './backup.ts';
import { runSync } from './sync/commands.ts';

const USAGE = `usage:
  knot init    --data <dir>
  knot import  --data <dir> --project <name> [--on-conflict skip|overwrite] <file.json>
  knot export  --data <dir> --project <name> [--format import] [--out <file.json>]
  knot export  --data <dir> --project <name> --with-files --out <file.zip>
  knot reindex --data <dir> [--project <name>]
  knot backup  --data <dir> --out <destdir>
  knot serve   --data <dir> [--port <n>] [--hostname <s>]
  knot token add --data <dir> --user <name> [--label <s>]
  knot token list --data <dir> --user <name>
  knot token revoke --data <dir> --id <id>
  knot user add --data <dir> --name <name> [--display-name <name>] [--admin]
                (パスワードは標準入力から読む: echo -n 'pass' | knot user add ...)
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull|push|status [--dir <dir>]   (詳細: knot sync --help 相当は SYNC_USAGE)`;

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  if (command === 'sync') {
    const result = await runSync(rest);
    process.exitCode = result.exitCode;
    return result.output;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      project: { type: 'string' },
      'on-conflict': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      'with-files': { type: 'boolean' },
      name: { type: 'string' },
      'display-name': { type: 'string' },
      admin: { type: 'boolean' },
      port: { type: 'string' },
      hostname: { type: 'string' },
      user: { type: 'string' },
      label: { type: 'string' },
      id: { type: 'string' },
    },
  });
  const data = values.data;
  if (command === undefined || data === undefined) throw new CliError(USAGE);
  switch (command) {
    case 'init':
      if (positionals.length !== 0) throw new CliError(USAGE);
      return runInit(data);
    case 'import': {
      const file = positionals[0];
      if (values.project === undefined || file === undefined || positionals.length !== 1) {
        throw new CliError(USAGE);
      }
      const onConflict = values['on-conflict'] ?? 'skip';
      if (onConflict !== 'skip' && onConflict !== 'overwrite') throw new CliError(USAGE);
      return runImport(data, values.project, file, onConflict);
    }
    case 'export': {
      if (values.project === undefined || positionals.length !== 0) throw new CliError(USAGE);
      const format = values.format ?? 'full';
      if (format !== 'full' && format !== 'import') throw new CliError(USAGE);
      const withFiles = values['with-files'] === true;
      if (withFiles && (values.out === undefined || format === 'import')) throw new CliError(USAGE);
      return runExport(data, values.project, format, values.out ?? null, withFiles);
    }
    case 'reindex':
      if (positionals.length !== 0) throw new CliError(USAGE);
      return runReindex(data, values.project ?? null);
    case 'backup':
      if (values.out === undefined || positionals.length !== 0) throw new CliError(USAGE);
      return runBackup(data, values.out);
    case 'serve': {
      if (positionals.length !== 0) throw new CliError(USAGE);
      const port = values.port === undefined ? 3000 : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError(USAGE);
      return runServe(data, port, values.hostname ?? '127.0.0.1');
    }
    case 'user': {
      if (positionals[0] !== 'add' || positionals.length !== 1 || values.name === undefined) {
        throw new CliError(USAGE);
      }
      const password = (await readStdin()).replace(/\n$/, '');
      return runUserAdd(data, values.name, values['display-name'] ?? null, values.admin === true, password);
    }
    case 'token':
      if (positionals[0] === 'add' && positionals.length === 1 && values.user !== undefined) {
        return runTokenAdd(data, values.user, values.label ?? 'default');
      }
      if (positionals[0] === 'list' && positionals.length === 1 && values.user !== undefined) {
        return runTokenList(data, values.user);
      }
      if (positionals[0] === 'revoke' && positionals.length === 1 && values.id !== undefined) {
        return runTokenRevoke(data, values.id);
      }
      throw new CliError(USAGE);
    default:
      throw new CliError(USAGE);
  }
}

main(process.argv.slice(2)).then(
  (out) => console.log(out),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
