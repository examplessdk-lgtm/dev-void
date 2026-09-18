import { execFile } from 'node:child_process';
import { log } from '@clack/prompts';
import { openBrowser } from './auth.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export type PlatformSetupPage = Readonly<{ title: string; url: string; instructions: string }>;

export function platformSetupLink(
  page: Pick<PlatformSetupPage, 'title' | 'url'>,
  hyperlinks: boolean = supportsSetupLinks(),
): string {
  return hyperlinks
    ? '\u001b]8;;' + page.url + '\u001b\\' + page.title + '\u001b]8;;\u001b\\'
    : page.title + ': ' + page.url;
}

export function platformSetupFieldHelp(
  key: string,
): Readonly<{ description: string; placeholder?: string }> | undefined {
  const docs = (section: string, title: string) =>
    platformSetupLink({
      title,
      url: 'https://void.cloud/guide/self-hosted-platform#' + section,
    });
  switch (key) {
    case 'databaseUrl':
      return {
        placeholder: 'postgresql://user:pw@…/database',
        description:
          'Stores platform users, projects, and deployments; use an empty hosted database, e.g. ' +
          platformSetupLink({ title: 'Neon', url: 'https://neon.com/' }) +
          '. ' +
          docs('platform-database', 'Database setup'),
      };
    case 'jwtSecret':
      return {
        description:
          'Signs platform login tokens. Run openssl rand -base64 32; save the key in your password manager. ' +
          docs('signing-and-encryption-keys', 'Key setup'),
      };
    case 'projectSecretKey':
      return {
        description:
          'Encrypts app secrets. Run openssl rand -base64 32 separately; save this key for recovery. ' +
          docs('signing-and-encryption-keys', 'Key setup'),
      };
    default:
      return undefined;
  }
}

function supportsSetupLinks(): boolean {
  return (
    !!process.stdout.isTTY &&
    (['ghostty', 'iTerm.app', 'WezTerm', 'vscode', 'WarpTerminal'].includes(
      process.env.TERM_PROGRAM ?? '',
    ) ||
      !!process.env.WT_SESSION ||
      !!process.env.VTE_VERSION ||
      !!process.env.KONSOLE_VERSION ||
      process.env.TERM === 'xterm-kitty')
  );
}

/** Dashboard keys use permission-catalog labels, which can differ from product names. */
export function platformSetupPages(plan: PlatformInstallPlan): {
  runtime: PlatformSetupPage;
  github: PlatformSetupPage;
  r2: PlatformSetupPage;
} {
  const needsGateway = plan.actions.some(
    (action) => action.kind === 'ai-gateway' && action.action === 'inspect',
  );
  const permissions = [
    { key: 'account_settings', type: 'read' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_r2', type: 'edit' },
    { key: 'd1', type: 'edit' },
    { key: 'queues', type: 'edit' },
    { key: 'account_analytics', type: 'read' },
    { key: 'workers_tail', type: 'read' },
    // Hyperdrive's catalog label is query_cache_write, not hyperdrive_write.
    { key: 'query_cache', type: 'edit' },
    // AI Gateway similarly uses aig_write in the permission catalog.
    ...(needsGateway ? [{ key: 'aig', type: 'edit' }] : []),
    ...(plan.deployment.application.zoneName ? [{ key: 'cache', type: 'purge' }] : []),
    ...(plan.deployment.capabilities.customDomains
      ? [{ key: 'ssl_and_certificates', type: 'edit' }]
      : []),
    // Administrator-registered email domains run the Email Routing / Email
    // Sending setup on this token against zones in this account.
    ...(plan.deployment.capabilities.email
      ? [
          { key: 'zone', type: 'read' },
          { key: 'zone_settings', type: 'edit' },
          { key: 'email_routing_rule', type: 'edit' },
          { key: 'email_sending', type: 'edit' },
        ]
      : []),
  ];
  const query = new URLSearchParams({
    to: '/' + plan.account.id + '/api-tokens',
    name: plan.deployment.displayName + ' Runtime',
    permissionGroupKeys: JSON.stringify(permissions),
  });
  return {
    runtime: {
      title: 'Cloudflare runtime token',
      url: 'https://dash.cloudflare.com/?' + query,
      instructions: [
        'Review the preselected permissions for account ' + plan.account.name + '.',
        'Edit: Workers Scripts, KV, R2, D1, Queues, Hyperdrive' +
          (needsGateway ? ', AI Gateway.' : '.'),
        'Read: Account Settings, Account Analytics, Workers Tail.',
        ...(plan.deployment.application.zoneName
          ? ['Zone ' + plan.deployment.application.zoneName + ': Cache Purge: Purge.']
          : []),
        ...(plan.deployment.capabilities.customDomains
          ? ['Custom project domains also need SSL and Certificates: Edit on that zone.']
          : []),
        ...(plan.deployment.capabilities.email
          ? [
              'Administrator-registered email domains need Zone: Read, Zone Settings: Edit and Email Routing Rules: Edit on the mail zones, and Email Sending: Edit.',
            ]
          : []),
        'If the form differs, match the permissions above. Create the token, then paste it here.',
      ].join('\n'),
    },
    github: {
      title: 'GitHub OAuth App',
      url: 'https://github.com/settings/applications/new',
      instructions:
        'GitHub Auth will be used by the users of your Void Platform instance. Register a GitHub app and generate a client secret.\nHomepage: ' +
        plan.apiUrl +
        '\nRedirect URI: ' +
        plan.apiUrl +
        '/auth/callback',
    },
    r2: {
      title: 'R2 upload token',
      // R2's form accepts the token type but does not read permission/name
      // prefills. Open creation directly and make the remaining choice explicit.
      url:
        'https://dash.cloudflare.com/?' +
        new URLSearchParams({
          to: '/' + plan.account.id + '/r2/api-tokens/create',
          type: 'account',
        }),
      instructions: [
        'Select Object Read & Write (the form defaults to read-only).',
        'Keep Apply to all buckets in this account (including newly created buckets) selected.',
        'Create the token, then copy the Access Key ID and Secret Access Key into the CLI.',
      ].join('\n'),
    },
  };
}

export function formatPlatformSetupPlan(plan: PlatformInstallPlan): string {
  const pages = platformSetupPages(plan);
  // Keep URLs outside wrapping note boxes so terminal links remain intact.
  return [
    'Credentials needed (paste them into the installer; keep a password-manager copy):',
    platformSetupLink(pages.runtime),
    pages.runtime.instructions,
    '',
    platformSetupLink(pages.r2),
    pages.r2.instructions,
    '',
    ...(plan.deployment.authentication.providers.includes('github')
      ? [platformSetupLink(pages.github), pages.github.instructions]
      : []),
    ...plan.deployment.authentication.providers
      .filter((provider) => provider !== 'github')
      .map(
        (provider) =>
          `${provider === 'google' ? 'Google OAuth client' : provider === 'oidc' ? 'OIDC connection' : 'Cloudflare Access OIDC application'}: client ID and secret; callback ${plan.apiUrl}/auth/callback.`,
      ),
    ...(plan.deployment.authentication.accessProtection
      ? [
          'Cloudflare Access protection: configure API and proxy origins and admitted installer/CI credentials.',
        ]
      : []),
  ].join('\n');
}

export function openPlatformSetupPage(
  page: PlatformSetupPage,
  dependencies: { interactive?: boolean; open?: (url: string) => void } = {},
): void {
  log.info(page.title + '\n' + page.instructions);
  console.log(platformSetupLink({ ...page, title: 'Open ' + page.title }));
  if (dependencies.interactive ?? process.stdin.isTTY === true) {
    try {
      (dependencies.open ?? ((url) => openBrowser(url, execFile)))(page.url);
    } catch {
      log.info('Could not open the browser. Use the link above.');
    }
  }
}
