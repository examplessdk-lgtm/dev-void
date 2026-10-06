import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  PLATFORM_LOGIN_KINDS,
  parsePlatformAccessProtection,
  parsePlatformAdmissionPolicy,
  parsePlatformAuthenticationSetup,
  parsePlatformLoginConfiguration,
  platformDashboardUrl,
  type PlatformDeploymentManifest,
  type PlatformLoginKind,
} from '@void/platform';
import { confirm, multiselect, password, select, text } from '@voidzero-dev/vite-plus-prompts';
import {
  activatePlatformAccessCredentials,
  parsePlatformAccessSetupSpec,
  preparePlatformAccessSetup,
  type PlatformAccessSetupSpec,
} from './platform-access-setup.ts';
import type { PlatformManagementAccess } from './platform-auth.ts';
import type { PlatformCloudflareClient } from './platform-cloudflare.ts';
import type { PlatformInstallPlan } from './platform-plan.ts';
import { platformPromptAnswer } from './platform-setup.ts';

export type AppAccessFile = {
  mode: import('@void/platform').PlatformAppAccess;
  tokenEnv?: string;
  identityProviderIds?: Array<string>;
  policyIds?: Array<string>;
};

type AuthFile = {
  appAccess?: AppAccessFile;
  connections: Array<{ configuration: Record<string, unknown>; clientSecretEnv?: string }>;
  administratorConnectionId?: string;
  admission?: unknown;
  protection?: unknown;
  cloudflareAccess?: PlatformAccessSetupSpec;
};
export type PlatformAuthSelection = {
  authentication: PlatformDeploymentManifest['authentication'];
  file?: AuthFile;
};

export function platformManagementAccessForAuthentication(
  selection: PlatformAuthSelection,
  accountId: string,
  checkpoint: Readonly<Record<string, string>> | null,
): PlatformManagementAccess | undefined {
  if (
    !selection.authentication.accessProtection &&
    (!selection.authentication.providers.includes('cloudflare-access') ||
      (selection.file && !selection.file.cloudflareAccess))
  ) {
    return undefined;
  }
  const spec =
    selection.file?.cloudflareAccess ??
    (checkpoint?.accessSetupSpecJson
      ? parsePlatformAccessSetupSpec(JSON.parse(checkpoint.accessSetupSpecJson))
      : undefined);
  if (spec?.accountId && spec.accountId !== accountId) {
    return undefined;
  }
  return {
    protection: !!selection.authentication.accessProtection,
    readOnly: spec?.mode === 'existing',
  };
}

export async function selectInstallationAuthentication(
  file: string | undefined,
  recorded?: PlatformDeploymentManifest['authentication'],
  choices: { loginMethods?: Array<PlatformLoginKind>; accessProtection?: boolean } = {},
): Promise<PlatformAuthSelection> {
  if (file) {
    const input: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('connections' in input) ||
      !Array.isArray(input.connections) ||
      !input.connections.length ||
      input.connections.length > 32
    ) {
      throw new Error('platform: An authentication file must define between 1 and 32 connections.');
    }
    const entries = input.connections as Array<{
      configuration?: Record<string, unknown>;
      clientSecret?: unknown;
      clientSecretEnv?: string;
    }>;
    if (
      entries.some(
        (entry) =>
          !entry ||
          typeof entry !== 'object' ||
          !entry.configuration ||
          typeof entry.configuration !== 'object' ||
          Array.isArray(entry.configuration) ||
          !PLATFORM_LOGIN_KINDS.includes(entry.configuration.kind as PlatformLoginKind) ||
          entry.clientSecret !== undefined ||
          entry.configuration.clientSecret !== undefined,
      )
    ) {
      throw new Error(
        'platform: Each connection needs a supported configuration and a clientSecretEnv reference; plaintext secrets are not accepted in the file.',
      );
    }
    const selected = input as AuthFile;
    if (selected.cloudflareAccess !== undefined) {
      selected.cloudflareAccess = parsePlatformAccessSetupSpec(selected.cloudflareAccess);
    }
    const authentication = {
      providers: [
        ...new Set(entries.map((entry) => entry.configuration!.kind as PlatformLoginKind)),
      ],
      configurable: true as const,
      ...(selected.protection ? { accessProtection: true as const } : {}),
    };
    if (recorded && JSON.stringify(authentication) !== JSON.stringify(recorded)) {
      throw new Error('platform: Resume with the recorded login methods and protection settings.');
    }
    return { authentication, file: selected };
  }
  if (recorded) {
    if (
      (choices.loginMethods &&
        JSON.stringify(choices.loginMethods) !== JSON.stringify(recorded.providers)) ||
      (choices.accessProtection !== undefined &&
        choices.accessProtection !== !!recorded.accessProtection)
    ) {
      throw new Error('platform: Resume with the recorded login methods and protection settings.');
    }
    return { authentication: recorded };
  }
  if (!process.stdin.isTTY && !choices.loginMethods && choices.accessProtection === undefined) {
    return { authentication: { providers: ['github'] } };
  }
  const providers =
    choices.loginMethods ??
    (!process.stdin.isTTY
      ? ['github' as const]
      : platformPromptAnswer(
          await multiselect<PlatformLoginKind>({
            message: 'Platform login methods (select all that apply):',
            initialValues: [],
            required: true,
            options: [
              { value: 'github' as const, label: 'GitHub' },
              { value: 'google' as const, label: 'Google' },
              { value: 'oidc' as const, label: 'Generic OIDC' },
              { value: 'cloudflare-access' as const, label: 'Cloudflare Access login' },
            ],
          }),
        ));
  const protection =
    choices.accessProtection ??
    (!process.stdin.isTTY
      ? false
      : platformPromptAnswer(
          await confirm({
            message: 'Also protect the platform UI and APIs with Cloudflare Access?',
            initialValue: false,
          }),
        ));
  const modern = protection || providers.length !== 1 || providers[0] !== 'github';
  return {
    authentication: {
      providers,
      ...(modern ? { configurable: true } : {}),
      ...(protection ? { accessProtection: true } : {}),
    },
  };
}

export async function collectInstallationAuthentication(
  selection: PlatformAuthSelection,
  plan: PlatformInstallPlan,
  checkpoint: Record<string, string>,
  save: (values: Record<string, string>) => void,
  access?: { client: PlatformCloudflareClient; ownershipNonce: string; yes: boolean },
): Promise<
  { authenticationSetupJson: string; authSetupToken: string; authBootstrapCode: string } | undefined
> {
  if (!selection.authentication.configurable) {
    return undefined;
  }
  activatePlatformAccessCredentials(checkpoint.accessCredentialsJson, [plan.apiUrl, plan.proxyUrl]);
  if (checkpoint.authenticationSetupJson && !selection.file) {
    parsePlatformAuthenticationSetup(JSON.parse(checkpoint.authenticationSetupJson));
    return {
      authenticationSetupJson: checkpoint.authenticationSetupJson,
      authSetupToken: checkpoint.authSetupToken ?? '',
      authBootstrapCode: checkpoint.authBootstrapCode ?? '',
    };
  }
  const prompt = async (message: string, initialValue = '', masked = false): Promise<string> => {
    if (!process.stdin.isTTY) {
      throw new Error(
        `platform: ${message} Supply it through --auth-config and environment references.`,
      );
    }
    return masked
      ? platformPromptAnswer(await password({ message }))
      : platformPromptAnswer(await text({ message, initialValue }));
  };
  const entries =
    selection.file?.connections ??
    selection.authentication.providers.map((kind) => ({
      configuration: {
        kind,
        id: kind === 'oidc' ? 'company' : kind === 'cloudflare-access' ? 'access' : kind,
        label:
          kind === 'github'
            ? 'GitHub'
            : kind === 'google'
              ? 'Google'
              : kind === 'oidc'
                ? 'Company SSO'
                : 'Cloudflare Access',
      } as Record<string, unknown>,
      clientSecretEnv: undefined,
    }));
  const connections = [];
  const accessEntry = entries.find((entry) => entry.configuration.kind === 'cloudflare-access');
  const prepared =
    access &&
    (selection.authentication.accessProtection ||
      (accessEntry && (!selection.file || selection.file.cloudflareAccess)))
      ? await preparePlatformAccessSetup({
          plan,
          ...(platformDashboardUrl(plan.deployment)
            ? { additionalOrigins: [platformDashboardUrl(plan.deployment)!] }
            : {}),
          ownershipNonce: access.ownershipNonce,
          protection: !!selection.authentication.accessProtection,
          ...(accessEntry
            ? {
                login: {
                  id: String(accessEntry.configuration.id ?? 'access'),
                  label: String(accessEntry.configuration.label ?? 'Cloudflare Access'),
                  ...(Array.isArray(accessEntry.configuration.requiredGroups)
                    ? { requiredGroups: accessEntry.configuration.requiredGroups as Array<string> }
                    : {}),
                },
              }
            : {}),
          spec: selection.file?.cloudflareAccess,
          client: access.client,
          checkpoint,
          save,
          yes: access.yes,
        })
      : undefined;
  console.log(`Login callback URL: ${plan.apiUrl}/auth/callback`);
  for (const entry of entries) {
    const config = { ...entry.configuration };
    const kind = config.kind as PlatformLoginKind;
    if (!config.id) {
      config.id = kind === 'oidc' ? 'company' : kind === 'cloudflare-access' ? 'access' : kind;
    }
    if (prepared?.login && prepared.login.configuration.id === config.id) {
      const connection = prepared.login;
      save({
        [`authenticationConnection:${connection.configuration.id}`]: JSON.stringify(connection),
      });
      connections.push(connection);
      continue;
    }
    const partialKey = `authenticationConnection:${String(config.id)}`;
    const stored = checkpoint[partialKey]
      ? (JSON.parse(checkpoint[partialKey]) as {
          configuration?: Record<string, unknown>;
          clientSecret?: string;
        })
      : undefined;
    Object.assign(config, { ...stored?.configuration, ...config });
    if (!config.label) {
      config.label = kind;
    }
    if ((kind === 'oidc' || kind === 'cloudflare-access') && !config.issuer) {
      config.issuer = await prompt(`${config.label}: issuer URL:`);
    }
    if (!config.clientId) {
      config.clientId = await prompt(`${config.label}: client ID:`);
    }
    if (kind === 'google' && config.allowedDomains === undefined && !selection.file) {
      config.allowedDomains = (
        await prompt('Allowed Google Workspace domains (comma-separated, or blank):')
      )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
    const parsed = parsePlatformLoginConfiguration(config);
    let secret: string | undefined;
    if (entry.clientSecretEnv) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.clientSecretEnv)) {
        throw new Error('platform: Invalid clientSecretEnv reference.');
      }
      secret = process.env[entry.clientSecretEnv];
      if (!secret) {
        throw new Error(`platform: ${entry.clientSecretEnv} must contain the login client secret.`);
      }
    } else if (
      stored?.clientSecret &&
      stored.configuration?.clientId === parsed.clientId &&
      stored.configuration?.issuer === parsed.issuer
    ) {
      secret = stored.clientSecret;
    } else {
      secret = await prompt(`${config.label}: client secret:`, '', true);
    }
    const connection = { configuration: parsed, clientSecret: secret };
    save({ [partialKey]: JSON.stringify(connection) });
    connections.push(connection);
  }
  const administratorConnectionId =
    selection.file?.administratorConnectionId ??
    (connections.length === 1
      ? connections[0]!.configuration.id
      : process.stdin.isTTY
        ? platformPromptAnswer(
            await select({
              message: 'Login method for the first administrator:',
              options: connections.map((entry) => ({
                value: entry.configuration.id,
                label: entry.configuration.label,
              })),
            }),
          )
        : connections[0]!.configuration.id);
  let protection = prepared?.protection ?? selection.file?.protection ?? null;
  if (selection.authentication.accessProtection && !protection) {
    const teamDomain = await prompt('Access team origin (https://team.cloudflareaccess.com):');
    const apiAudience = await prompt(`Access application audience for ${plan.apiUrl}:`);
    const proxyAudience = await prompt(
      `Access application audience for ${plan.proxyUrl}:`,
      apiAudience,
    );
    protection = {
      teamDomain,
      applications: [
        { origin: plan.apiUrl, audience: apiAudience },
        { origin: plan.proxyUrl, audience: proxyAudience },
      ],
    };
  }
  protection = parsePlatformAccessProtection(protection);
  let admissionInput =
    selection.file?.admission ??
    (protection ? { mode: 'company', access: true, connections: [] } : { mode: 'restricted' });
  if (!selection.file && !protection && process.stdin.isTTY) {
    const eligible = connections.filter(
      (entry) =>
        entry.configuration.kind !== 'github' &&
        (entry.configuration.kind !== 'google' || entry.configuration.allowedDomains.length > 0),
    );
    const mode = platformPromptAnswer(
      await select<'restricted' | 'company' | 'public'>({
        message: 'Who can create an account?',
        initialValue: eligible.length ? 'company' : 'restricted',
        options: [
          { value: 'restricted', label: 'Invited or allowlisted users' },
          ...(eligible.length
            ? [
                {
                  value: 'company' as const,
                  label: 'Users approved by company login methods — automatic accounts',
                },
              ]
            : []),
          { value: 'public', label: 'Anyone who completes an enabled login' },
        ],
      }),
    );
    const ids =
      mode === 'company'
        ? platformPromptAnswer(
            await multiselect({
              message: 'Company login methods that qualify new users:',
              required: true,
              initialValues: eligible.map((entry) => entry.configuration.id),
              options: eligible.map((entry) => ({
                value: entry.configuration.id,
                label: entry.configuration.label,
              })),
            }),
          )
        : [];
    admissionInput = mode === 'company' ? { mode, connections: ids, access: false } : { mode };
  }
  const admission = parsePlatformAdmissionPolicy(admissionInput);
  let authBootstrapCode = checkpoint.authBootstrapCode || randomBytes(32).toString('hex');
  const authSetupToken = checkpoint.authSetupToken || randomBytes(32).toString('hex');
  let setup = parsePlatformAuthenticationSetup({
    connections,
    administratorConnectionId,
    admission,
    protection,
    bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
  });
  if (selection.file && checkpoint.authenticationSetupJson) {
    const previous = parsePlatformAuthenticationSetup(
      JSON.parse(checkpoint.authenticationSetupJson),
    );
    if (JSON.stringify({ ...previous, resetPending: undefined }) !== JSON.stringify(setup)) {
      authBootstrapCode = randomBytes(32).toString('hex');
      setup = parsePlatformAuthenticationSetup({
        ...setup,
        resetPending: true,
        bootstrapCredentialHash: createHash('sha256').update(authBootstrapCode).digest('hex'),
      });
    }
  }
  const result = {
    authenticationSetupJson: JSON.stringify(setup),
    authBootstrapCode,
    authSetupToken,
  };
  save(result);
  return result;
}
