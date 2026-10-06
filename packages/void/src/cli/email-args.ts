import type { SubcommandDef } from './subcommand-prompt.ts';

const PLATFORM_FLAG = {
  name: '--platform',
  arg: '<cloudflare|void>',
  description: 'Your own Cloudflare account (`cloudflare`) instead of the Void platform',
};

export const emailSubcommands: Array<SubcommandDef> = [
  { name: 'usage', description: 'Show monthly recipient attempts, inbound receipts, and quota' },
  { name: 'logs', description: 'Show recent email delivery activity' },
  { name: 'destinations', description: 'List verified recipient addresses for outbound mail' },
  { name: 'allow', arg: '<address>', description: 'Add a recipient and trigger CF verification' },
  { name: 'disallow', arg: '<address>', description: 'Remove a verified recipient' },
  // The first (and only) nested group: the verb is collected as the arg so
  // `domain list` completes in the interactive prompt; `domain add` then
  // errors naming the missing <domain>, the same as a typed invocation.
  {
    name: 'domain',
    arg: '<add|status|list|sync|rotate-secret|remove>',
    description: 'Send and receive at your own domain on a Cloudflare zone',
  },
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
  'domain',
  'status',
  'setup',
] as const;

export const EMAIL_DOMAIN_VERBS = [
  'add',
  'status',
  'list',
  'sync',
  'rotate-secret',
  'remove',
] as const;
export type EmailDomainVerb = (typeof EMAIL_DOMAIN_VERBS)[number];

export interface EmailArgs {
  subcommand: (typeof EMAIL_SUBCOMMANDS)[number];
  /** The nested `void email domain <verb>` verb — set only when subcommand is 'domain'. */
  domainVerb?: EmailDomainVerb;
  /** The domain positional of a domain verb (absent for `domain list`). */
  domain?: string;
  /**
   * `--subdomain <label|host>` on `domain add`: which subdomain to register
   * instead of the `mail.<domain>` the MX decision proposes (design doc 0078,
   * "[change with --subdomain]").
   */
  subdomain?: string;
  projectSlug?: string;
  limit?: number;
  address?: string;
  /**
   * `--platform cloudflare`: the developer's own account (design doc 0078, Mode B).
   * `--platform void` names the Void platform explicitly; leaving the flag off means the
   * same.
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
      'email: Usage: void email <usage|logs|destinations|allow|disallow|domain|status|setup> [args] [--project <name>] [--limit <n>] [--platform cloudflare].',
    );
  }

  let limit: number | undefined;
  // Raw values, one per occurrence, so a repeated flag is reported as repeated even when
  // its final value would have been accepted — the same precedence `void deploy` keeps.
  // `--project` is collected the same way, so a wrapper's override and a caller's cannot
  // silently disagree about which project `void email disallow` mutates.
  const projectValues: Array<string> = [];
  const platformValues: Array<string> = [];
  const subdomainValues: Array<string> = [];
  const positional: Array<string> = [];

  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    // `--project` and `--limit` take the same missing-value path as `--platform`: a bare
    // flag must not fall through as a positional, which the read-only subcommands never
    // reject.
    if (rest[i] === '--project' || rest[i]?.startsWith('--project=')) {
      const { value, next } = readFlagValue(rest, i, '--project');
      // `--project=` and `--project ''` (an empty shell variable) read as a bare flag:
      // an empty slug is not nullish, so `runEmailCommand` would otherwise skip
      // `VOID_PROJECT` and act on the linked project as if no override was given.
      if (value === undefined || value.trim() === '') {
        throw new Error('email: --project requires a value (a project name).');
      }
      projectValues.push(value);
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
      throw new Error("email: Unknown option '--backend'.");
    } else if (rest[i] === '--subdomain' || rest[i]?.startsWith('--subdomain=')) {
      const { value, next } = readFlagValue(rest, i, '--subdomain');
      // Same missing-value rule as --project: a bare flag or an empty shell
      // variable reads as no value, not as the next flag's name.
      if (value === undefined || value.trim() === '') {
        throw new Error('email: --subdomain requires a value (a subdomain label or host).');
      }
      subdomainValues.push(value);
      i = next;
    } else {
      positional.push(rest[i]);
    }
  }

  // Same rule as `void deploy`: `--project` at most once.
  if (projectValues.length > 1) {
    throw new Error('email: --project can only be specified once.');
  }
  const projectSlug = projectValues[0];

  if (platformValues.length > 1) {
    throw new Error('email: --platform can only be specified once.');
  }

  let platform: EmailArgs['platform'];
  const platformValue = platformValues[0];
  if (platformValue !== undefined) {
    if (platformValue !== 'cloudflare' && platformValue !== 'void') {
      throw new Error("email: --platform must be 'cloudflare' or 'void'.");
    }
    platform = platformValue;
  }
  if (subdomainValues.length > 1) {
    throw new Error('email: --subdomain can only be specified once.');
  }
  const subdomain = subdomainValues[0];

  // The nested `domain` group parses its own positionals (verb + domain) and
  // returns early — the one-positional rule below would read the verb as the
  // address. Mode B needs none of this group (0078,
  // "Mode B" under custom domains), so it is Void-platform-only.
  if (subcommand === 'domain') {
    if (platform === 'cloudflare') {
      throw new Error(
        'email: --platform cloudflare applies to `void email status` and `void email setup` only (`domain` is a Void platform command).',
      );
    }
    return parseEmailDomainArgs(positional, { projectSlug, limit, platform, subdomain });
  }
  if (subdomain !== undefined) {
    throw new Error('email: --subdomain applies to `void email domain add` only.');
  }

  // `void email allow|disallow` takes exactly one address; extras are an
  // error rather than silently ignored.
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

/**
 * The nested `void email domain <verb> [<domain>]` group. positional[0] is the
 * verb, positional[1] the domain — `list` takes no domain, every other verb
 * requires exactly one. Shape validation of the domain itself is the command's
 * job (and ultimately the api's — its regex is authoritative); the parser only
 * counts positionals, exactly as it does for `allow <address>`.
 */
function parseEmailDomainArgs(
  positional: ReadonlyArray<string>,
  flags: {
    projectSlug?: string;
    limit?: number;
    platform?: EmailArgs['platform'];
    subdomain?: string;
  },
): EmailArgs {
  const verb = positional[0];
  if (!verb || !(EMAIL_DOMAIN_VERBS as ReadonlyArray<string>).includes(verb)) {
    throw new Error(
      'email: Usage: void email domain <add|status|list|sync|rotate-secret|remove> [<domain>] [--project <name>].',
    );
  }
  if (flags.subdomain !== undefined && verb !== 'add') {
    throw new Error('email: --subdomain applies to `void email domain add` only.');
  }
  const domain = positional[1];
  if (verb === 'list') {
    if (domain !== undefined) {
      throw new Error('email: `void email domain list` takes no domain argument.');
    }
  } else if (domain === undefined) {
    throw new Error(`email: Usage: void email domain ${verb} <domain> [--project <name>].`);
  }
  if (positional.length > 2) {
    throw new Error(
      `email: \`void email domain ${verb}\` takes exactly one domain argument (got ${positional.length - 1}: ${positional
        .slice(1)
        .map((p) => JSON.stringify(p))
        .join(', ')}).`,
    );
  }
  return {
    subcommand: 'domain',
    domainVerb: verb as EmailDomainVerb,
    domain,
    subdomain: flags.subdomain,
    projectSlug: flags.projectSlug,
    limit: flags.limit,
    platform: flags.platform,
  };
}
