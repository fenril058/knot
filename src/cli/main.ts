#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CliError, runExport, runImport, runInit, runReindex, runServe, runUserAdd } from './commands.ts';

const USAGE = `usage:
  knot init    --data <dir>
  knot import  --data <dir> --project <name> [--on-conflict skip|overwrite] <file.json>
  knot export  --data <dir> --project <name> [--format import] [--out <file.json>]
  knot reindex --data <dir> [--project <name>]
  knot serve   --data <dir> [--port <n>] [--hostname <s>]
  knot user add --data <dir> --name <name> [--display-name <name>] [--admin]
                (パスワードは標準入力から読む: echo -n 'pass' | knot user add ...)`;

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      project: { type: 'string' },
      'on-conflict': { type: 'string' },
      format: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      'display-name': { type: 'string' },
      admin: { type: 'boolean' },
      port: { type: 'string' },
      hostname: { type: 'string' },
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
      return runExport(data, values.project, format, values.out ?? null);
    }
    case 'reindex':
      if (positionals.length !== 0) throw new CliError(USAGE);
      return runReindex(data, values.project ?? null);
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
