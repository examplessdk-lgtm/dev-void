import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import {
  type CANCEL_SYMBOL,
  confirm,
  isCancel,
  multiselect,
  password,
  select,
  text,
} from '@clack/prompts';
import type { PlatformInstallationManifest } from '@void/platform';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  PlatformAccessClient,
  platformAccessIdentityProvider,
  provisionPlatformAccess,
  type PlatformAccessCheckpoint,
  type PlatformAccessProvisionResult,
} from './platform-access-provision.ts';
import { PlatformCloudflareApiError, PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';

export function platformAccessResourceInventory(
  encoded: string | undefined,
  installationId: string,
): NonNullable<PlatformInstallationManifest['authenticationResources']> {
  if (!encoded) {
    return [];
  }
  const state = JSON.parse(encoded) as PlatformAccessCheckpoint;
  if (
    state.version !== 1 ||
    state.installationId !== installationId ||
    typeof state.accountId !== 'string' ||
    !state.resources
  ) {
    throw new Error('platform: Access resource recovery data belongs to another installation.');
  }
  return Object.entries(state.resources).flatMap(([key, resource]) =>
    resource.id
      ? [
          {
            key,
            kind: key.includes('service-token')
              ? ('service-token' as const)
              : ('application' as const),
            accountId: state.accountId,
            id: resource.id,
            name: resource.name,
            ownership: resource.adopted ? ('adopted' as const) : ('created' as const),
          },
        ]
      : [],
  );
}

export function checkpointPlatformAccessResources(
  manifest: PlatformInstallationManifest,
  encoded: string | undefined,
  updatedAt: string,
): PlatformInstallationManifest {
  const resources = platformAccessResourceInventory(encoded, manifest.id);
  const previous = manifest.authenticationResources ?? [];
  return resources.length
    ? {
        ...manifest,
        authenticationResources: [
          ...previous,
          ...resources.filter(
            (resource) =>
              !previous.some(
                (saved) =>
                  saved.accountId === resource.accountId &&
                  saved.kind === resource.kind &&
                  saved.id === resource.id,
              ),
          ),
        ],
        updatedAt,
      }
    : manifest;
}

export type PlatformAccessSetupSpec = {
  mode: 'create' | 'existing';
  accountId?: string;
  identityProviderIds?: Array<string>;
  policyIds?: Array<string>;
  loginApplicationId?: string;
  protectionApplicationId?: string;
  loginClientSecretEnv?: string;
  serviceToken?: { id: string; clientIdEnv: string; clientSecretEnv: string };
};

export function isPlatformAuthenticationPreparationKey(name: string): boolean {
  return (
    name.startsWith('authenticationConnection:') ||
    [
      'accessManagementToken',
      'accessSetupSpecJson',
      'accessExistingServiceTokenJson',
      'accessExistingLoginSecret',
    ].includes(name)
  );
}

/** Validate before planning; credential references are resolved only during provisioning. */
export function parsePlatformAccessSetupSpec(input: unknown): PlatformAccessSetupSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('platform: cloudflareAccess must contain an Access setup configuration.');
  }
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    'mode',
    'accountId',
    'identityProviderIds',
    'policyIds',
    'loginApplicationId',
    'protectionApplicationId',
    'loginClientSecretEnv',
    'serviceToken',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(
      'platform: Unknown Access setup field. Use environment references for credentials.',
    );
  }
  if (value.mode !== 'create' && value.mode !== 'existing') {
    throw new Error('platform: Access setup mode must be create or existing.');
  }
  for (const key of [
    'accountId',
    'loginApplicationId',
    'protectionApplicationId',
    'loginClientSecretEnv',
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || !value[key] || String(value[key]).length > 256)
    ) {
      throw new Error(`platform: Invalid Access ${key}.`);
    }
  }
  for (const key of ['identityProviderIds', 'policyIds']) {
    const ids = value[key];
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > 16 ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
        new Set(ids).size !== ids.length)
    ) {
      throw new Error(`platform: Invalid Access ${key}.`);
    }
  }
  if (
    value.loginClientSecretEnv &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.loginClientSecretEnv))
  ) {
    throw new Error('platform: Invalid Access client secret environment reference.');
  }
  if (value.serviceToken !== undefined) {
    const token = value.serviceToken;
    if (
      !token ||
      typeof token !== 'object' ||
      Array.isArray(token) ||
      Object.keys(token).some((key) => !['id', 'clientIdEnv', 'clientSecretEnv'].includes(key))
    ) {
      throw new Error('platform: Access service tokens require an ID and environment references.');
    }
    const fields = token as Record<string, unknown>;
    if (
      typeof fields.id !== 'string' ||
      !fields.id ||
      fields.id.length > 256 ||
      ['clientIdEnv', 'clientSecretEnv'].some(
        (key) =>
          typeof fields[key] !== 'string' ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fields[key] as string),
      )
    ) {
      throw new Error('platform: Invalid Access service token environment references.');
    }
  }
  return value as PlatformAccessSetupSpec;
}

function answer<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}
function secretReference(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !process.env[name]) {
    throw new Error('platform: Supply the referenced Access credential in the environment.');
  }
  return process.env[name]!;
}

/** Only scoped credentials for the reviewed platform origins enter the process environment. */
export function activatePlatformAccessCredentials(
  encoded: string | undefined,
  origins: ReadonlyArray<string>,
): void {
  if (!encoded) {
    return;
  }
  const entries: unknown = JSON.parse(encoded);
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('platform: Invalid saved Access credentials.');
  }
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  for (const [origin, value] of Object.entries(entries)) {
    if (!allowed.has(origin) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        'platform: Access credentials must be scoped to this platform’s API or proxy.',
      );
    }
    const headers = cfAccessHeaders(
      { VOID_ACCESS_CREDENTIALS: JSON.stringify({ [origin]: value }) },
      origin,
    );
    if (!Object.keys(headers).length) {
      throw new Error('platform: Saved Access credentials are incomplete.');
    }
  }
  const current: unknown = process.env.VOID_ACCESS_CREDENTIALS
    ? JSON.parse(process.env.VOID_ACCESS_CREDENTIALS)
    : {};
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('platform: VOID_ACCESS_CREDENTIALS must contain an origin-keyed object.');
  }
  process.env.VOID_ACCESS_CREDENTIALS = JSON.stringify({ ...current, ...entries });
}

export async function preparePlatformAccessSetup(input: {
  plan: Pick<PlatformInstallPlan, 'account' | 'installationId' | 'apiUrl' | 'proxyUrl'>;
  additionalOrigins?: ReadonlyArray<string>;
  ownershipNonce: string;
  login?: { id: string; label: string; requiredGroups?: Array<string> };
  protection: boolean;
  spec?: PlatformAccessSetupSpec;
  client: PlatformCloudflareClient;
  checkpoint: Record<string, string>;
  save: (values: Record<string, string>) => void;
  yes: boolean;
}): Promise<PlatformAccessProvisionResult | undefined> {
  if (!input.login && !input.protection) {
    return undefined;
  }
  let spec =
    input.spec ??
    (input.checkpoint.accessSetupSpecJson
      ? parsePlatformAccessSetupSpec(JSON.parse(input.checkpoint.accessSetupSpecJson))
      : undefined);
  if (!spec) {
    if (!process.stdin.isTTY) {
      if (input.protection) {
        throw new Error(
          'platform: Protection requires cloudflareAccess create or existing application verification in --auth-config.',
        );
      }
      return undefined;
    }
    const mode = answer(
      await select({
        message: 'Cloudflare Access setup:',
        options: [
          {
            value: 'create',
            label: 'Create applications automatically in this Cloudflare account',
          },
          { value: 'existing', label: 'Connect existing applications (including another account)' },
          ...(!input.protection
            ? [
                {
                  value: 'manual',
                  label: 'Connect an existing OIDC issuer without Cloudflare management access',
                },
              ]
            : []),
        ],
      }),
    );
    if (mode === 'manual') {
      return undefined;
    }
    spec = { mode: mode as 'create' | 'existing' };
    if (mode === 'existing') {
      spec.accountId = answer(
        await text({
          message: 'Cloudflare identity account ID:',
          initialValue: input.plan.account.id,
        }),
      );
      if (input.login) {
        spec.loginApplicationId = answer(
          await text({ message: 'Existing Access OIDC application ID:' }),
        );
      }
      if (input.protection) {
        spec.protectionApplicationId = answer(
          await text({ message: 'Existing Access protection application ID:' }),
        );
      }
    }
  }
  spec = parsePlatformAccessSetupSpec(spec);
  input.save({ accessSetupSpecJson: JSON.stringify(spec) });
  const accountId = spec.accountId ?? input.plan.account.id;
  const credential =
    process.env.VOID_PLATFORM_ACCESS_SETUP_TOKEN || input.checkpoint.accessManagementToken;
  let management = credential
    ? new PlatformCloudflareClient(credential, { apiBase: input.client.apiBaseUrl })
    : input.client;
  let client = new PlatformAccessClient(management, accountId);
  let providers: Array<Record<string, unknown>>;
  let policies: Array<Record<string, unknown>>;
  try {
    await client.get('organizations');
    providers = await client.list('identity_providers');
    policies = await client.list('policies');
  } catch (error) {
    if (
      !(error instanceof PlatformCloudflareApiError) ||
      ![401, 403].includes(error.status) ||
      !process.stdin.isTTY ||
      credential
    ) {
      throw error;
    }
    console.error(
      `Access setup for account ${accountId} needs Access applications/policies permissions and organization/identity-provider/group read access${input.protection ? ', plus service-token permissions' : ''}.`,
    );
    const token = answer(
      await password({ message: 'Access setup API token (kept out of the platform runtime):' }),
    );
    input.save({ accessManagementToken: token });
    management = new PlatformCloudflareClient(token, { apiBase: input.client.apiBaseUrl });
    client = new PlatformAccessClient(management, accountId);
    await client.get('organizations');
    providers = await client.list('identity_providers');
    policies = await client.list('policies');
  }
  const identityProviderIds =
    spec.identityProviderIds ??
    (process.stdin.isTTY
      ? answer(
          await multiselect({
            message: 'Company identity providers:',
            required: true,
            options: providers
              .filter((provider) => typeof provider.id === 'string')
              .map(platformAccessIdentityProvider)
              .map((provider) => ({
                value: provider.id,
                label: stripVTControlCharacters(provider.name),
              })),
          }),
        )
      : []);
  const policyIds =
    spec.policyIds ??
    (process.stdin.isTTY
      ? answer(
          await multiselect({
            message:
              'Existing company Access policies (MFA and device requirements are preserved):',
            required: true,
            options: policies
              .filter(
                (policy) =>
                  typeof policy.id === 'string' &&
                  ['allow', 'deny'].includes(String(policy.decision)),
              )
              .map((policy) => ({
                value: String(policy.id),
                label: stripVTControlCharacters(String(policy.name ?? policy.id)),
              })),
          }),
        )
      : []);
  if (!identityProviderIds.length || !policyIds.length) {
    throw new Error('platform: Access setup requires explicit identityProviderIds and policyIds.');
  }
  spec = { ...spec, identityProviderIds, policyIds };
  input.save({ accessSetupSpecJson: JSON.stringify(spec) });
  if (
    spec.mode === 'existing' &&
    ((input.login && !spec.loginApplicationId) ||
      (input.protection && !spec.protectionApplicationId))
  ) {
    throw new Error(
      'platform: Existing Access setup requires application IDs for each selected capability.',
    );
  }
  let serviceToken = spec.serviceToken
    ? {
        id: spec.serviceToken.id,
        clientId: secretReference(spec.serviceToken.clientIdEnv),
        clientSecret: secretReference(spec.serviceToken.clientSecretEnv),
      }
    : undefined;
  if (!serviceToken && spec.mode === 'existing' && input.protection) {
    if (input.checkpoint.accessExistingServiceTokenJson) {
      serviceToken = JSON.parse(input.checkpoint.accessExistingServiceTokenJson);
    } else if (process.stdin.isTTY) {
      serviceToken = {
        id: answer(await text({ message: 'Existing admitted Access service token ID:' })),
        clientId: answer(await password({ message: 'Access service token client ID:' })),
        clientSecret: answer(await password({ message: 'Access service token client secret:' })),
      };
      input.save({ accessExistingServiceTokenJson: JSON.stringify(serviceToken) });
    }
  }
  if (spec.mode === 'existing' && input.protection && !serviceToken) {
    throw new Error(
      'platform: Supply the service token already admitted by the existing protection application.',
    );
  }
  const reviewed = {
    accountId,
    login: input.login?.id ?? null,
    protection: input.protection,
    identityProviderIds,
    policyIds,
    origins: input.protection
      ? [input.plan.apiUrl, input.plan.proxyUrl, ...(input.additionalOrigins ?? [])]
      : [],
    mode: spec.mode,
  };
  console.log(JSON.stringify({ accessPlan: reviewed }, null, 2));
  if (!input.yes) {
    if (
      !process.stdin.isTTY ||
      !answer(await confirm({ message: 'Apply this Access configuration?', initialValue: false }))
    ) {
      throw new Error('platform: Access setup changes require confirmation or --yes.');
    }
  }
  const previous = input.checkpoint.accessProvisioningJson
    ? (JSON.parse(input.checkpoint.accessProvisioningJson) as PlatformAccessCheckpoint)
    : {
        version: 1 as const,
        accountId,
        installationId: input.plan.installationId,
        nonce: createHash('sha256')
          .update(`void-access:${input.ownershipNonce}`)
          .digest('hex')
          .slice(0, 32),
        resources: {},
      };
  let loginClientSecret = spec.loginClientSecretEnv
    ? secretReference(spec.loginClientSecretEnv)
    : input.checkpoint.accessExistingLoginSecret;
  if (input.login && spec.mode === 'existing' && !loginClientSecret && process.stdin.isTTY) {
    loginClientSecret = answer(await password({ message: 'Existing Access OIDC client secret:' }));
    input.save({ accessExistingLoginSecret: loginClientSecret });
  }
  const result = await provisionPlatformAccess(
    client,
    {
      accountId,
      installationId: input.plan.installationId,
      apiUrl: input.plan.apiUrl,
      proxyUrl: input.plan.proxyUrl,
      additionalOrigins: input.additionalOrigins,
      identityProviderIds,
      policyIds,
      ...(input.login
        ? {
            login: {
              ...input.login,
              applicationId: spec.loginApplicationId,
              ...(loginClientSecret ? { clientSecret: loginClientSecret } : {}),
            },
          }
        : {}),
      ...(input.protection ? { protection: { applicationId: spec.protectionApplicationId } } : {}),
      serviceToken,
    },
    previous,
    (state) => input.save({ accessProvisioningJson: JSON.stringify(state) }),
  );
  if (result.credentials) {
    const accessCredentialsJson = JSON.stringify(result.credentials);
    input.save({ accessCredentialsJson });
    activatePlatformAccessCredentials(accessCredentialsJson, [
      input.plan.apiUrl,
      input.plan.proxyUrl,
      ...(input.additionalOrigins ?? []),
    ]);
  }
  return result;
}
