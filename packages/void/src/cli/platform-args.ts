import type { SubcommandDef } from './subcommand-prompt.ts';

export const platformSubcommands: Array<SubcommandDef> = [
  { name: 'connect', arg: '[url]', description: 'Connect to an existing Void platform' },
  { name: 'list', description: 'List installed and connected platforms' },
  { name: 'use', arg: '[id]', description: 'Select the default Void platform' },
  { name: 'status', arg: '[id]', description: 'Inspect a platform and its health' },
  { name: 'discover', description: 'Recover installations from a Cloudflare account' },
  { name: 'install', description: 'Install a Void platform in Cloudflare' },
  { name: 'upgrade', arg: '[id]', description: 'Upgrade an installed Void platform' },
  { name: 'repair', arg: '[id]', description: 'Reconcile an installed Void platform' },
  { name: 'disable', arg: '[id]', description: 'Disable traffic without deleting data' },
  { name: 'enable', arg: '[id]', description: 'Restore traffic for a disabled platform' },
  { name: 'uninstall', arg: '[id]', description: 'Safely remove an installed Void platform' },
];

export type PlatformArgs =
  | { subcommand: 'connect'; url: string }
  | { subcommand: 'list' }
  | { subcommand: 'use'; selector: string }
  | { subcommand: 'status'; selector: string }
  | { subcommand: 'discover'; account: string; selector: string }
  | {
      subcommand: 'install';
      account: string;
      applicationDomain: string;
      controlPlaneDomain: string;
      dedicatedZone: boolean;
      displayName: string;
      name: string;
      plan: boolean;
      resume: boolean;
      runtime: string;
      yes: boolean;
      zone: string;
    }
  | {
      subcommand: 'upgrade' | 'repair' | 'disable' | 'enable';
      selector: string;
      plan: boolean;
      runtime: string;
      yes: boolean;
    }
  | {
      subcommand: 'uninstall';
      selector: string;
      plan: boolean;
      purgeData: boolean;
      deleteZone: boolean | null;
      yes: boolean;
    };

function readValue(rest: Array<string>, index: number, flag: string): [string, number] {
  const value = rest[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`platform: ${flag} requires a value.`);
  }
  return [value, index + 1];
}

function parseSelector(
  rest: Array<string>,
  subcommand: string,
  options: { allowYes?: boolean } = {},
): { selector: string; plan: boolean; yes: boolean } {
  let selector = '';
  let plan = false;
  let yes = false;
  for (const arg of rest) {
    if (arg === '--plan') {
      plan = true;
    } else if (arg === '--yes' && options.allowYes) {
      yes = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`platform: Unknown flag '${arg}'.`);
    } else if (selector) {
      throw new Error(`platform: Unexpected argument '${arg}'.`);
    } else {
      selector = arg;
    }
  }
  if ((subcommand === 'use' || subcommand === 'connect' || subcommand === 'status') && plan) {
    throw new Error("platform: Unknown flag '--plan'.");
  }
  return { selector, plan, yes };
}

function parseLifecycleSelector(
  rest: Array<string>,
  subcommand: 'upgrade' | 'repair' | 'disable' | 'enable',
): { selector: string; plan: boolean; runtime: string; yes: boolean } {
  const positional: Array<string> = [];
  let runtime = '';
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--runtime') {
      if (subcommand === 'disable') {
        throw new Error("platform: Unknown flag '--runtime'.");
      }
      const [value, next] = readValue(rest, index, arg);
      runtime = value;
      index = next;
    } else {
      positional.push(arg);
    }
  }
  const parsed = parseSelector(positional, subcommand, { allowYes: true });
  return { ...parsed, runtime };
}

export function parsePlatformArgs(args: Array<string>): PlatformArgs {
  const [subcommand, ...rest] = args;

  if (subcommand === 'connect') {
    const { selector: url } = parseSelector(rest, subcommand);
    return { subcommand, url };
  }
  if (subcommand === 'list') {
    if (rest.length > 0) {
      throw new Error(`platform: Unexpected argument '${rest[0]}'.`);
    }
    return { subcommand };
  }
  if (subcommand === 'use') {
    const { selector } = parseSelector(rest, subcommand);
    return { subcommand, selector };
  }
  if (subcommand === 'status') {
    const { selector, plan } = parseSelector(rest, subcommand);
    if (plan) {
      throw new Error("platform: Unknown flag '--plan'.");
    }
    return { subcommand, selector };
  }
  if (subcommand === 'discover') {
    let account = '';
    let selector = '';
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === '--account' || arg === '--installation') {
        const [value, next] = readValue(rest, index, arg);
        if (arg === '--account') {
          account = value;
        } else {
          selector = value;
        }
        index = next;
      } else {
        throw new Error(
          'platform: Usage: void platform discover [--account <id>] [--installation <id-or-name>].',
        );
      }
    }
    return { subcommand, account, selector };
  }
  if (
    subcommand === 'upgrade' ||
    subcommand === 'repair' ||
    subcommand === 'disable' ||
    subcommand === 'enable'
  ) {
    const { selector, plan, runtime, yes } = parseLifecycleSelector(rest, subcommand);
    return { subcommand, selector, plan, runtime, yes };
  }
  if (subcommand === 'uninstall') {
    const parsed = parseSelector(
      rest.filter((arg) => !['--purge-data', '--delete-zone', '--keep-zone'].includes(arg)),
      subcommand,
      { allowYes: true },
    );
    if (rest.includes('--delete-zone') && rest.includes('--keep-zone')) {
      throw new Error('platform: --delete-zone and --keep-zone cannot be used together.');
    }
    return {
      subcommand,
      selector: parsed.selector,
      plan: parsed.plan,
      purgeData: rest.includes('--purge-data'),
      yes: parsed.yes,
      deleteZone: rest.includes('--delete-zone')
        ? true
        : rest.includes('--keep-zone')
          ? false
          : null,
    };
  }
  if (subcommand === 'install') {
    const values = new Map<string, string>();
    let plan = false;
    let resume = false;
    let dedicatedZone = false;
    let yes = false;
    const valueFlags = new Set([
      '--account',
      '--application-domain',
      '--control-plane-domain',
      '--display-name',
      '--name',
      '--runtime',
      '--zone',
    ]);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (valueFlags.has(arg)) {
        const [value, next] = readValue(rest, i, arg);
        values.set(arg, value);
        i = next;
      } else if (arg === '--plan') {
        plan = true;
      } else if (arg === '--resume') {
        resume = true;
      } else if (arg === '--dedicated-zone') {
        dedicatedZone = true;
      } else if (arg === '--yes') {
        yes = true;
      } else {
        throw new Error(`platform: Unexpected argument '${arg}'.`);
      }
    }
    return {
      subcommand,
      account: values.get('--account') ?? '',
      applicationDomain: values.get('--application-domain') ?? '',
      controlPlaneDomain: values.get('--control-plane-domain') ?? '',
      dedicatedZone,
      displayName: values.get('--display-name') ?? '',
      name: values.get('--name') ?? '',
      plan,
      resume,
      runtime: values.get('--runtime') ?? '',
      yes,
      zone: values.get('--zone') ?? '',
    };
  }

  throw new Error(
    'platform: Usage: void platform <connect|list|use|status|discover|install|upgrade|repair|disable|enable|uninstall>.',
  );
}
