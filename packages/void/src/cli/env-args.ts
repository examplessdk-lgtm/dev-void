import { parseArgs } from 'node:util';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const envSubcommands: Array<SubcommandDef> = [
  {
    name: 'check',
    description: 'Validate local .env or required remote secret names',
    flags: [
      {
        name: '--remote',
        description: 'Also check that required keys exist as remote secrets',
      },
    ],
  },
  {
    name: 'types',
    description: 'Regenerate .void/env.d.ts from env.ts',
  },
];

export type EnvArgs = { subcommand: 'check'; useRemoteSecrets: boolean } | { subcommand: 'types' };

export function parseEnvArgs(args: Array<string>): EnvArgs {
  const [subcommand, ...rest] = args;
  if (subcommand === 'check') {
    const parsed = parseArgs({
      args: rest,
      options: { remote: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 0) {
      throw new Error(`env: Unexpected argument '${parsed.positionals[0]}'.`);
    }
    return { subcommand: 'check', useRemoteSecrets: !!parsed.values.remote };
  }
  if (subcommand === 'types') {
    if (rest.length > 0) {
      throw new Error(`env: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand: 'types' };
  }
  throw new Error('env: Usage: void env <check|types>.');
}
