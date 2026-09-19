import { operatorGroups, parseOperatorArgs, type OperatorArgs } from './operator-args.ts';
import { parsePlatformConfigArgs, type PlatformConfigArgs } from './platform-config-args.ts';
import type { SubcommandDef } from './subcommand-prompt.ts';

export const platformSubcommands: Array<SubcommandDef> = [
  {
    name: 'config',
    hint: 'Configure authentication',
    description: 'Configure login methods, company protection, or provider recovery',
  },
  ...operatorGroups.map((name) => ({
    name,
    hint:
      name === 'email' ? 'Domains, policy, limits, outcomes, and recovery' : 'Operator commands',
    description: `Administer platform ${name}`,
  })),
  { name: 'list', description: 'List installed and connected platforms' },
  { name: 'use', arg: '[id]', description: 'Select the default Void platform' },
  { name: 'status', arg: '[id]', description: 'Inspect a platform and its health' },
  { name: 'discover', description: 'Recover installations from a Cloudflare account' },
  {
    name: 'domain',
    hint: 'Set an application domain',
    description: 'Add a domain to a workers.dev test platform',
  },
  {
    name: 'install',
    description: 'Install a Void platform with a domain or workers.dev for testing',
  },
  { name: 'upgrade', arg: '[id]', description: 'Upgrade an installed Void platform' },
  { name: 'rollback', arg: '[id]', description: 'Restore a compatible earlier platform runtime' },
  { name: 'repair', arg: '[id]', description: 'Reconcile an installed Void platform' },
  { name: 'disable', arg: '[id]', description: 'Disable traffic without deleting data' },
  { name: 'enable', arg: '[id]', description: 'Restore traffic for a disabled platform' },
  { name: 'uninstall', arg: '[id]', description: 'Safely remove an installed Void platform' },
];

export type PlatformArgs =
  | PlatformConfigArgs
  | OperatorArgs
  | { subcommand: 'list' }
  | { subcommand: 'use'; selector: string }
  | { subcommand: 'status'; selector: string }
  | { subcommand: 'discover'; account: string; selector: string }
  | {
      subcommand: 'domain';
      domain: string;
      selector: string;
      zone: string;
      dedicatedZone: boolean;
      plan: boolean;
      yes: boolean;
    }
  | {
      subcommand: 'install';
      authConfig?: string;
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
      workersDev?: boolean;
    }
  | {
      subcommand: 'upgrade' | 'repair' | 'disable' | 'enable';
      selector: string;
      plan: boolean;
      runtime: string;
      yes: boolean;
    }
  | {
      subcommand: 'rollback';
      selector: string;
      plan: boolean;
      runtime: string;
      fromRuntime: string;
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
  if ((subcommand === 'use' || subcommand === 'status') && plan) {
    throw new Error("platform: Unknown flag '--plan'.");
  }
  return { selector, plan, yes };
}

function parseLifecycleSelector(
  rest: Array<string>,
  subcommand: 'upgrade' | 'rollback' | 'repair' | 'disable' | 'enable',
): { selector: string; plan: boolean; runtime: string; fromRuntime: string; yes: boolean } {
  const positional: Array<string> = [];
  let runtime = '';
  let fromRuntime = '';
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === '--runtime') {
      if (subcommand === 'disable') {
        throw new Error("platform: Unknown flag '--runtime'.");
      }
      const [value, next] = readValue(rest, index, arg);
      runtime = value;
      index = next;
    } else if (arg === '--from-runtime' && subcommand === 'rollback') {
      const [value, next] = readValue(rest, index, arg);
      fromRuntime = value;
      index = next;
    } else {
      positional.push(arg);
    }
  }
  const parsed = parseSelector(positional, subcommand, { allowYes: true });
  if (subcommand === 'rollback' && !runtime) {
    throw new Error('platform: rollback requires --runtime <earlier-runtime-directory>.');
  }
  return { ...parsed, runtime, fromRuntime };
}

export function parsePlatformArgs(args: Array<string>): PlatformArgs {
  if (
    operatorGroups.includes(args[0] ?? '') ||
    ['--connection', '--json', '--plan', '--yes', '--timeout'].includes(args[0] ?? '')
  ) {
    return parseOperatorArgs(args);
  }
  const [subcommand, ...rest] = args;
  if (subcommand === 'config') {
    return parsePlatformConfigArgs(rest);
  }

  if (subcommand === 'domain') {
    if (rest.length === 0) {
      return {
        subcommand,
        domain: '',
        selector: '',
        zone: '',
        dedicatedZone: false,
        plan: false,
        yes: false,
      };
    }
    if (rest[0] !== 'set') {
      throw new Error(
        'platform: Usage: void platform domain set <domain> [--installation <id>] [--zone <domain>] [--dedicated-zone] [--plan] [--yes].',
      );
    }
    let domain = '';
    let selector = '';
    let zone = '';
    let plan = false;
    let yes = false;
    let dedicatedZone = false;
    for (let index = 1; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === '--installation' || arg === '--zone') {
        const [value, next] = readValue(rest, index, arg);
        index = next;
        if (arg === '--zone') {
          zone = value;
        } else {
          selector = value;
        }
      } else if (arg === '--plan') {
        plan = true;
      } else if (arg === '--yes') {
        yes = true;
      } else if (arg === '--dedicated-zone') {
        dedicatedZone = true;
      } else if (!arg.startsWith('-') && !domain) {
        domain = arg;
      } else {
        throw new Error(`platform: Unexpected argument '${arg}'.`);
      }
    }
    if (!domain) {
      throw new Error('platform: domain set requires an application domain.');
    }
    if (plan && yes) {
      throw new Error('platform: Use either --plan or --yes.');
    }
    return { subcommand, domain, selector, zone, dedicatedZone, plan, yes };
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
    subcommand === 'rollback' ||
    subcommand === 'repair' ||
    subcommand === 'disable' ||
    subcommand === 'enable'
  ) {
    const { selector, plan, runtime, fromRuntime, yes } = parseLifecycleSelector(rest, subcommand);
    return subcommand === 'rollback'
      ? { subcommand, selector, plan, runtime, fromRuntime, yes }
      : { subcommand, selector, plan, runtime, yes };
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
      '--auth-config',
      '--application-domain',
      '--control-plane-domain',
      '--display-name',
      '--name',
      '--runtime',
      '--zone',
    ]);
    let workersDev = false;
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
      } else if (arg === '--workers-dev') {
        workersDev = true;
      } else {
        throw new Error(`platform: Unexpected argument '${arg}'.`);
      }
    }
    if (
      workersDev &&
      (values.has('--application-domain') || values.has('--zone') || dedicatedZone)
    ) {
      throw new Error(
        'platform: --workers-dev cannot be combined with a domain, zone, or --dedicated-zone.',
      );
    }
    return {
      subcommand,
      ...(workersDev ? { workersDev: true } : {}),
      ...(values.has('--auth-config') ? { authConfig: values.get('--auth-config')! } : {}),
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
    'platform: Usage: void platform <config|auth|user|project|deployment|build|signup|invitation|email|system|worker|list|use|status|discover|install|domain|upgrade|rollback|repair|disable|enable|uninstall>.',
  );
}
