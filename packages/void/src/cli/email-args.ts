import type { SubcommandDef } from './subcommand-prompt.ts';

export const emailSubcommands: Array<SubcommandDef> = [
  { name: 'usage', description: 'Show monthly email send/receive counts and quota' },
  { name: 'logs', description: 'Show recent email delivery activity' },
  { name: 'destinations', description: 'List verified recipient addresses for outbound mail' },
  { name: 'allow', arg: '<address>', description: 'Add a recipient and trigger CF verification' },
  { name: 'disallow', arg: '<address>', description: 'Remove a verified recipient' },
];

export interface EmailArgs {
  subcommand: 'usage' | 'logs' | 'destinations' | 'allow' | 'disallow';
  projectSlug?: string;
  limit?: number;
  address?: string;
}

export function parseEmailArgs(args: Array<string>): EmailArgs {
  const subcommand = args[0] as EmailArgs['subcommand'];
  if (!subcommand || !['usage', 'logs', 'destinations', 'allow', 'disallow'].includes(subcommand)) {
    throw new Error(
      'email: Usage: void email <usage|logs|destinations|allow|disallow> [args] [--project <name>] [--limit <n>].',
    );
  }

  let projectSlug: string | undefined;
  let limit: number | undefined;
  const positional: Array<string> = [];

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project' && rest[i + 1]) {
      projectSlug = rest[++i];
    } else if (rest[i] === '--limit' && rest[i + 1]) {
      const raw = rest[++i];
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`email: --limit must be a positive integer (got '${raw}').`);
      }
      limit = n;
    } else {
      positional.push(rest[i]);
    }
  }

  // `void email allow|disallow` takes exactly one address. Silently
  // dropping extras (the previous behavior, which kept only the first)
  // led to confusing UX — `void email allow a@x.dev b@y.dev` quietly
  // ignored `b@y.dev`. Error explicitly so the user knows to retry.
  if (positional.length > 1) {
    throw new Error(
      `email: \`void email ${subcommand}\` takes exactly one positional argument (got ${positional.length}: ${positional.map((p) => JSON.stringify(p)).join(', ')}).`,
    );
  }

  const address = positional[0];

  if ((subcommand === 'allow' || subcommand === 'disallow') && !address) {
    throw new Error(`email: Usage: void email ${subcommand} <address> [--project <name>].`);
  }

  return { subcommand, projectSlug, limit, address };
}
