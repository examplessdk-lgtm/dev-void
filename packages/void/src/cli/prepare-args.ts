import { parseArgs } from 'node:util';

export function parsePrepareArgs(args: Array<string>): void {
  const parsed = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  });

  if (parsed.positionals.length > 0) {
    throw new Error(`prepare: Unexpected argument '${parsed.positionals[0]}'.`);
  }
}
