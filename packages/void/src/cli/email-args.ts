import type { SubcommandDef } from './subcommand-prompt.ts';

const BACKEND_FLAG = {
  name: '--backend',
  arg: '<name>',
  description: 'Your own Cloudflare account (`cloudflare`) instead of the Void platform',
};

export const emailSubcommands: Array<SubcommandDef> = [
  { name: 'usage', description: 'Show monthly email send/receive counts and quota' },
  { name: 'logs', description: 'Show recent email delivery activity' },
  { name: 'destinations', description: 'List verified recipient addresses for outbound mail' },
  { name: 'allow', arg: '<address>', description: 'Add a recipient and trigger CF verification' },
  { name: 'disallow', arg: '<address>', description: 'Remove a verified recipient' },
  {
    name: 'status',
    description: 'Show the email setup state and address map',
    flags: [BACKEND_FLAG],
  },
  {
    name: 'setup',
    description: 'Set email up on your own Cloudflare account (--backend cloudflare)',
    flags: [BACKEND_FLAG],
  },
];

const EMAIL_SUBCOMMANDS = [
  'usage',
  'logs',
  'destinations',
  'allow',
  'disallow',
  'status',
  'setup',
] as const;

export interface EmailArgs {
  subcommand: (typeof EMAIL_SUBCOMMANDS)[number];
  projectSlug?: string;
  limit?: number;
  address?: string;
  /** `--backend cloudflare`: the developer's own account (design doc 0078, Mode B). */
  backend?: 'cloudflare';
}

export function parseEmailArgs(args: Array<string>): EmailArgs {
  const subcommand = args[0] as EmailArgs['subcommand'];
  if (!subcommand || !(EMAIL_SUBCOMMANDS as ReadonlyArray<string>).includes(subcommand)) {
    throw new Error(
      'email: Usage: void email <usage|logs|destinations|allow|disallow|status|setup> [args] [--project <name>] [--limit <n>] [--backend cloudflare].',
    );
  }

  let projectSlug: string | undefined;
  let limit: number | undefined;
  let backend: EmailArgs['backend'];
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
    } else if (rest[i] === '--backend' || rest[i]?.startsWith('--backend=')) {
      const raw = rest[i] === '--backend' ? rest[++i] : rest[i]!.slice('--backend='.length);
      if (raw !== 'cloudflare') {
        throw new Error(
          raw === undefined || raw.startsWith('-')
            ? "email: --backend requires a value ('cloudflare')."
            : "email: --backend must be 'cloudflare'.",
        );
      }
      backend = 'cloudflare';
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

  // The Cloudflare backend reads the local project (void.json, email/, wrangler.jsonc)
  // and the developer's own wrangler session — it never resolves a Void project, so
  // `--project` would name a destination it cannot use. Only `status` and `setup`
  // have a Mode B shape; the platform-only subcommands reject the flag outright.
  if (backend === 'cloudflare') {
    if (subcommand !== 'status' && subcommand !== 'setup') {
      throw new Error(
        `email: --backend cloudflare applies to \`void email status\` and \`void email setup\` only (\`${subcommand}\` is a Void platform command).`,
      );
    }
    if (projectSlug !== undefined) {
      throw new Error(
        'email: --project cannot be combined with --backend cloudflare (it reads the local project, not a Void project).',
      );
    }
    if (address !== undefined) {
      throw new Error(
        `email: \`void email ${subcommand} --backend cloudflare\` takes no argument.`,
      );
    }
  }

  return { subcommand, projectSlug, limit, address, backend };
}
