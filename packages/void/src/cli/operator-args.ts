import { OPERATOR_MAX_TIMEOUT_MS } from './operator-client.ts';

/** Public operator commands. This table also drives nested CLI help. */
export type OperatorCommand = {
  group: string;
  action: string;
  description: string;
  positional?: Array<string>;
  optionalPositional?: boolean;
  values?: Record<string, string>;
  booleans?: Array<string>;
  method?: 'POST';
  path: string;
};

export const operatorCommands: Array<OperatorCommand> = [
  {
    group: 'auth',
    action: 'login',
    description: 'Sign in as a platform administrator',
    path: '/session',
    values: { provider: 'OAuth provider' },
    booleans: ['token-stdin'],
  },
  {
    group: 'auth',
    action: 'logout',
    description: 'Revoke the current operator session and remove its local credential',
    path: '/session/logout',
  },
  {
    group: 'auth',
    action: 'status',
    description: 'Inspect operator identity, expiry, and capabilities',
    path: '/session',
  },
  {
    group: 'auth',
    action: 'token',
    description: 'Print an operator token; exchange an API session with --token-stdin',
    path: '/session',
    booleans: ['token-stdin'],
  },
  {
    group: 'user',
    action: 'list',
    description: 'List users',
    path: '/users',
    values: { search: 'Search login or email' },
  },
  {
    group: 'user',
    action: 'show',
    description: 'Inspect a user, usage, and projects',
    path: '/users/:id',
    positional: ['id'],
  },
  {
    group: 'user',
    action: 'plan',
    description: 'Change a user plan',
    path: '/users/:id/plan',
    positional: ['id', 'plan'],
    method: 'POST',
  },
  {
    group: 'user',
    action: 'suspend',
    description: 'Suspend a user and their projects',
    path: '/users/:id/suspend',
    positional: ['id'],
    values: { reason: 'Reason for suspension' },
    method: 'POST',
  },
  {
    group: 'user',
    action: 'restore',
    description: 'Restore a suspended user',
    path: '/users/:id/restore',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'user',
    action: 'delete',
    description: 'Delete a user and all owned resources',
    path: '/users/:id/delete',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'project',
    action: 'list',
    description: 'List tenant projects',
    path: '/projects',
    values: { user: 'Owner user ID', search: 'Search projects' },
  },
  {
    group: 'project',
    action: 'show',
    description: 'Inspect a project and its resources',
    path: '/projects/:id',
    positional: ['id'],
  },
  {
    group: 'project',
    action: 'delete',
    description: 'Delete a project and its resources',
    path: '/projects/:id/delete',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'deployment',
    action: 'list',
    description: 'List tenant deployments',
    path: '/deployments',
    values: { project: 'Project ID', search: 'Search deployments', status: 'Deployment status' },
  },
  {
    group: 'deployment',
    action: 'show',
    description: 'Inspect a deployment',
    path: '/deployments/:id',
    positional: ['id'],
  },
  {
    group: 'deployment',
    action: 'cancel',
    description: 'Cancel a deployment',
    path: '/deployments/:id/cancel',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'deployment',
    action: 'logs',
    description: 'Read runtime logs (JSON follow emits one object per line)',
    path: '/deployments/:id/logs',
    positional: ['id'],
    values: { since: 'Duration or ISO timestamp', cursor: 'Opaque continuation cursor' },
    booleans: ['follow'],
  },
  {
    group: 'build',
    action: 'show',
    description: 'Inspect a managed build',
    path: '/builds/:id',
    positional: ['id'],
  },
  {
    group: 'build',
    action: 'logs',
    description: 'Read build logs (JSON follow emits one object per line)',
    path: '/builds/:id/logs',
    positional: ['id'],
    values: { since: 'Last received sequence number' },
    booleans: ['follow'],
  },
  {
    group: 'signup',
    action: 'show',
    description: 'Inspect signup restrictions and allowlist',
    path: '/signup',
  },
  {
    group: 'signup',
    action: 'restrict',
    description: 'Restrict signup to the allowlist',
    path: '/signup/restrict',
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'open',
    description: 'Open public signup',
    path: '/signup/open',
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'allow',
    description: 'Add a github or email allowlist pattern',
    path: '/signup/allow',
    positional: ['type', 'pattern'],
    values: { note: 'Allowlist note' },
    method: 'POST',
  },
  {
    group: 'signup',
    action: 'remove',
    description: 'Remove a github or email allowlist pattern',
    path: '/signup/remove',
    positional: ['type', 'pattern'],
    method: 'POST',
  },
  { group: 'invitation', action: 'list', description: 'List invitations', path: '/invitations' },
  {
    group: 'invitation',
    action: 'send',
    description: 'Send invitations to comma-separated email addresses',
    path: '/invitations/send',
    positional: ['emails'],
    method: 'POST',
  },
  {
    group: 'invitation',
    action: 'revoke',
    description: 'Revoke an invitation',
    path: '/invitations/:id/revoke',
    positional: ['id'],
    method: 'POST',
  },
  {
    group: 'system',
    action: 'overview',
    description: 'Inspect platform usage and capacity',
    path: '/system/overview',
  },
  {
    group: 'system',
    action: 'health',
    description: 'Check platform health',
    path: '/system/health',
  },
  {
    group: 'system',
    action: 'cli-versions',
    description: 'Inspect CLI version adoption and deployment statistics',
    path: '/system/cli-versions',
  },
  {
    group: 'system',
    action: 'events',
    description: 'List operator audit events',
    path: '/system/events',
  },
  {
    group: 'system',
    action: 'backfill-queue-tokens',
    description: 'Repair missing queue authentication tokens',
    path: '/system/backfill-queue-tokens',
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'list',
    description: 'List hosted platform workers',
    path: '/workers',
    values: { environment: 'production or staging' },
  },
  {
    group: 'worker',
    action: 'show',
    description: 'Inspect hosted worker versions',
    path: '/workers/:id',
    positional: ['id'],
    values: { environment: 'production or staging' },
  },
  {
    group: 'worker',
    action: 'rollback',
    description: 'Roll back a hosted worker to a version',
    path: '/workers/:id/rollback',
    positional: ['id', 'versionId'],
    values: { environment: 'production or staging' },
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'rollback-all',
    description: 'Roll back all hosted workers to their previous versions',
    path: '/workers/rollback-all',
    values: { environment: 'production or staging' },
    method: 'POST',
  },
  {
    group: 'worker',
    action: 'events',
    description: 'List hosted worker events or inspect a batch',
    path: '/workers/events',
    positional: ['batchId'],
    optionalPositional: true,
    values: { environment: 'production or staging' },
  },
];

export const operatorGroups: Array<string> = [
  ...new Set(operatorCommands.map(({ group }) => group)),
];
export type OperatorArgs = {
  subcommand: 'operator';
  group: string;
  action: string;
  connection: string;
  json: boolean;
  plan: boolean;
  yes: boolean;
  follow: boolean;
  tokenStdin: boolean;
  provider: string;
  timeoutMs?: number;
  method: 'GET' | 'POST';
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
};

export function parseOperatorArgs(args: Array<string>): OperatorArgs {
  const positional: Array<string> = [];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const booleanFlags = new Set(['json', 'plan', 'yes', 'follow', 'token-stdin']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`platform: Unknown flag '${arg}'.`);
    }
    const flag = arg.slice(2);
    if (flags.has(flag) || Object.hasOwn(values, flag)) {
      throw new Error(`platform: Duplicate flag '${arg}'.`);
    }
    if (booleanFlags.has(flag)) {
      flags.add(flag);
    } else {
      const value = args[++index];
      if (!value || value.startsWith('-')) {
        throw new Error(`platform: ${arg} requires a value.`);
      }
      values[flag] = value;
    }
  }
  const [group = '', action = '', ...parameters] = positional;
  if (!operatorGroups.includes(group)) {
    throw new Error('platform: Unknown operator command group.');
  }
  const parsed: OperatorArgs = {
    subcommand: 'operator',
    group,
    action,
    connection: values.connection ?? '',
    json: flags.has('json'),
    plan: flags.has('plan'),
    yes: flags.has('yes'),
    follow: flags.has('follow'),
    tokenStdin: flags.has('token-stdin'),
    provider: values.provider ?? 'github',
    method: 'GET',
    path: '',
    query: {},
    body: {},
  };
  if (!action && args.length === 1) {
    return parsed;
  }
  const command = operatorCommands.find(
    (entry) => entry.group === group && entry.action === action,
  );
  if (!command) {
    throw new Error(
      `platform: Usage: void platform ${group} <${operatorCommands
        .filter((entry) => entry.group === group)
        .map(({ action }) => action)
        .join('|')}>.`,
    );
  }
  const count = command.positional?.length ?? 0;
  if (parameters.length > count || (!command.optionalPositional && parameters.length !== count)) {
    throw new Error(
      `platform: Usage: void platform ${group} ${action}${command.positional?.map((name) => ` <${name}>`).join('') ?? ''}.`,
    );
  }
  const paged = action === 'list' || action === 'events' || action === 'logs';
  const allowed = new Set([
    'connection',
    ...(command.method ? ['timeout'] : []),
    ...Object.keys(command.values ?? {}),
    ...(paged ? ['limit', ...(action !== 'logs' ? ['page'] : [])] : []),
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) {
      throw new Error(`platform: Unknown flag '--${name}' for ${group} ${action}.`);
    }
  }
  for (const name of flags) {
    if (
      !['json', ...(command.method ? ['yes', 'plan'] : []), ...(command.booleans ?? [])].includes(
        name,
      )
    ) {
      throw new Error(`platform: Unknown flag '--${name}' for ${group} ${action}.`);
    }
  }
  if (parsed.plan && parsed.yes) {
    throw new Error('platform: --plan and --yes cannot be combined.');
  }
  parsed.path = command.path;
  parsed.method = command.method ?? 'GET';
  for (const [index, name] of (command.positional ?? []).entries()) {
    const value = parameters[index];
    if (value === undefined) {
      continue;
    }
    if (value === '.' || value === '..') {
      throw new Error('platform: An object ID cannot be a dot path segment.');
    }
    if (parsed.path.includes(`:${name}`)) {
      parsed.path = parsed.path.replace(`:${name}`, encodeURIComponent(value));
    } else if (group === 'worker' && action === 'events') {
      parsed.path += `/${encodeURIComponent(value)}`;
    } else {
      parsed.body[name] = name === 'emails' ? value.split(',').map((email) => email.trim()) : value;
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (name === 'connection' || name === 'provider') {
      continue;
    }
    if (name === 'timeout') {
      const maximum = OPERATOR_MAX_TIMEOUT_MS / 1_000;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
        throw new Error(`platform: --timeout must be an integer from 1 to ${maximum} seconds.`);
      }
      parsed.timeoutMs = Number(value) * 1_000;
      continue;
    }
    if (name === 'page' || name === 'limit') {
      const maximum = name === 'limit' ? (action === 'logs' ? 500 : 100) : 1_000_000;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) {
        throw new Error(`platform: --${name} must be an integer from 1 to ${maximum}.`);
      }
    }
    if (
      name === 'since' &&
      group === 'build' &&
      (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    ) {
      throw new Error('platform: --since must be a nonnegative safe integer for build logs.');
    }
    if (name === 'environment' && !['production', 'staging'].includes(value)) {
      throw new Error('platform: --environment must be production or staging.');
    }
    if (parsed.method === 'POST') {
      parsed.body[name] = value;
    } else {
      parsed.query[name] = value;
    }
  }
  if (parsed.body.type && !['github', 'email'].includes(String(parsed.body.type))) {
    throw new Error('platform: Signup pattern type must be github or email.');
  }
  return parsed;
}
