#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CliError, runExport, runImport, runInit, runReindex } from './commands.ts';

const USAGE = `usage:
  knot init    --data <dir>
  knot import  --data <dir> --project <name> [--on-conflict skip|overwrite] <file.json>
  knot export  --data <dir> --project <name> [--format import] [--out <file.json>]
  knot reindex --data <dir> [--project <name>]`;

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
