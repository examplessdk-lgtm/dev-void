import type { SubcommandDef } from './subcommand-prompt.ts';

const PLATFORM_FLAG = {
  name: '--platform',
  arg: '<cloudflare|void>',
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
    flags: [PLATFORM_FLAG],
  },
  {
    name: 'setup',
    description: 'Set email up on your own Cloudflare account (--platform cloudflare)',
    flags: [PLATFORM_FLAG],
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
  /**
   * `--platform cloudflare`: the developer's own account (design doc 0078, Mode B).
   * `--platform void` names the Void platform explicitly; leaving the flag off means the
   * same. The legacy `--backend cloudflare` alias normalizes to `'cloudflare'` here.
   */
  platform?: 'cloudflare' | 'void';
}

/**
 * Read a value-taking flag in its `--flag value` or `--flag=value` form. Returns the
 * raw value, or `undefined` when the flag is the last token or is followed by another
 * option — the same rule `parseArgs` applies for `void deploy`, so `--platform --limit 3`
 * is a missing value, not a value of `--limit`.
 */
function readFlagValue(
  rest: ReadonlyArray<string>,
  i: number,
  flag: string,
): { value: string | undefined; next: number } {
  const token = rest[i]!;
  if (token.startsWith(`${flag}=`)) {
    return { value: token.slice(flag.length + 1), next: i };
  }
  const value = rest[i + 1];
  if (value === undefined || value.startsWith('-')) {
    return { value: undefined, next: i };
  }
  return { value, next: i + 1 };
}

export function parseEmailArgs(args: Array<string>): EmailArgs {
  const subcommand = args[0] as EmailArgs['subcommand'];
  if (!subcommand || !(EMAIL_SUBCOMMANDS as ReadonlyArray<string>).includes(subcommand)) {
    throw new Error(
      'email: Usage: void email <usage|logs|destinations|allow|disallow|status|setup> [args] [--project <name>] [--limit <n>] [--platform cloudflare].',
    );
  }

  let projectSlug: string | undefined;
  let limit: number | undefined;
  // Raw values, one per occurrence, so a repeated flag is reported as repeated even when
  // its final value would have been accepted — the same precedence `void deploy` keeps.
  const platformValues: Array<string> = [];
  const backendValues: Array<string> = [];
  const positional: Array<string> = [];

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    // `--project` and `--limit` take the same missing-value path as `--platform`: a bare
    // flag used to fall through as a positional, which the read-only subcommands never
    // reject — so `void email usage --project` ran against the linked project and
    // `void email logs --limit` ignored the limit instead of reporting it missing.
    if (rest[i] === '--project' || rest[i]?.startsWith('--project=')) {
      const { value, next } = readFlagValue(rest, i, '--project');
      if (value === undefined) {
        throw new Error('email: --project requires a value (a project name).');
      }
      projectSlug = value;
      i = next;
    } else if (rest[i] === '--limit' || rest[i]?.startsWith('--limit=')) {
      const { value: raw, next } = readFlagValue(rest, i, '--limit');
      if (raw === undefined) {
        throw new Error('email: --limit requires a value (a positive integer).');
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`email: --limit must be a positive integer (got '${raw}').`);
      }
      limit = n;
      i = next;
    } else if (rest[i] === '--platform' || rest[i]?.startsWith('--platform=')) {
      const { value, next } = readFlagValue(rest, i, '--platform');
      if (value === undefined) {
        throw new Error("email: --platform requires a value ('cloudflare' or 'void').");
      }
      platformValues.push(value);
      i = next;
    } else if (rest[i] === '--backend' || rest[i]?.startsWith('--backend=')) {
      const { value, next } = readFlagValue(rest, i, '--backend');
      if (value === undefined) {
        throw new Error("email: --backend requires a value ('cloudflare').");
      }
      backendValues.push(value);
      i = next;
    } else {
      positional.push(rest[i]);
    }
  }

  // `--platform <cloudflare|void>` is canonical; `--backend cloudflare` is the legacy
  // alias `void deploy` also keeps. Same rules as deploy: each at most once, never both.
  if (backendValues.length > 1) {
    throw new Error('email: --backend can only be specified once.');
  }
  if (platformValues.length > 1) {
    throw new Error('email: --platform can only be specified once.');
  }
  if (platformValues.length > 0 && backendValues.length > 0) {
    throw new Error('email: --platform and --backend cannot be used together.');
  }

  let platform: EmailArgs['platform'];
  const platformValue = platformValues[0];
  if (platformValue !== undefined) {
    if (platformValue !== 'cloudflare' && platformValue !== 'void') {
      throw new Error("email: --platform must be 'cloudflare' or 'void'.");
    }
    platform = platformValue;
  }
  const backendValue = backendValues[0];
  if (backendValue !== undefined) {
    if (backendValue !== 'cloudflare') {
      throw new Error("email: --backend must be 'cloudflare'.");
    }
    platform = 'cloudflare';
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

  // The Cloudflare platform reads the local project (void.json, email/, wrangler.jsonc)
  // and the developer's own wrangler session — it never resolves a Void project, so
  // `--project` would name a destination it cannot use. Only `status` and `setup`
  // have a Mode B shape; the platform-only subcommands reject the flag outright.
  // `--platform void` is the default spelled out, so it is accepted everywhere.
  if (platform === 'cloudflare') {
    if (subcommand !== 'status' && subcommand !== 'setup') {
      throw new Error(
        `email: --platform cloudflare applies to \`void email status\` and \`void email setup\` only (\`${subcommand}\` is a Void platform command).`,
      );
    }
    if (projectSlug !== undefined) {
      throw new Error(
        'email: --project cannot be combined with --platform cloudflare (it reads the local project, not a Void project).',
      );
    }
    if (address !== undefined) {
      throw new Error(
        `email: \`void email ${subcommand} --platform cloudflare\` takes no argument.`,
      );
    }
  }

  return { subcommand, projectSlug, limit, address, platform };
}
