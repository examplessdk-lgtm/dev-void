import { randomBytes } from 'node:crypto';
import { confirm, intro, isCancel, log, note, outro, password, select, text } from '@clack/prompts';
import {
  normalizeApplicationDomain,
  normalizeInstallationSlug,
  type PlatformInstallationManifest,
} from '@void/platform';
import { cliTitle } from './output.ts';
import type { PlatformArgs } from './platform-args.ts';
import {
  assertPlatformOperatorCredentialCanApplyPlan,
  resolvePlatformCloudflareCredential,
} from './platform-auth.ts';
import {
  PlatformCloudflareClient,
  PlatformCloudflareApiError,
  verifyPlatformRuntimeTokenPermissions,
  type CloudflareAccount,
} from './platform-cloudflare.ts';
import {
  acquirePlatformDatabaseLifecycleLock,
  createPlatformInstallationSecrets,
  installPlatform,
  loadPlatformRuntime,
  readPlatformDatabaseLifecycleManifest,
  resolveBootstrapGitHubId,
} from './platform-installer.ts';
import {
  createPlatformInstallPlan,
  formatPlatformInstallPlan,
  revalidatePlatformInstallAction,
} from './platform-plan.ts';
import {
  acquirePlatformLifecycleLock,
  assertPlatformInstallationSlugAvailable,
  listInstallationManifests,
  readPendingInstallationSecrets,
  resolveInstallationManifest,
  writeInstallationManifest,
  writePendingInstallationSecrets,
} from './platform-registry.ts';
import {
  completePlatformSetupDraft,
  isPlatformSetupDraft,
  savePlatformSetupDraft,
} from './platform-setup-draft.ts';
import {
  formatPlatformSetupPlan,
  openPlatformSetupPage,
  platformSetupPages,
} from './platform-setup.ts';

export function resolvePlatformInstallDatabaseUrl(
  checkpoint: Record<string, string> | null,
  manifest: PlatformInstallationManifest | null = null,
): string {
  const explicit = process.env.VOID_PLATFORM_DATABASE_URL || process.env.DATABASE_URL || '';
  const recorded = checkpoint?.databaseUrl || '';
  const databaseBound =
    checkpoint?.databaseClaimState === 'claimed' ||
    manifest?.resources.some(
      (resource) =>
        resource.state === 'ready' &&
        (resource.kind === 'hyperdrive' || resource.kind === 'worker'),
    ) ||
    manifest?.steps.some(
      (step) =>
        step.key.startsWith('database-schema:') || step.key.startsWith('database-migrations:'),
    );
  if (databaseBound) {
    if (!recorded) {
      if (explicit) {
        // Discovery intentionally recovers no credentials. The database's
        // installation claim and ownership nonce are verified under the
        // advisory lock before any lifecycle mutation, and the live
        // Hyperdrive origin is checked against this URL before redeployment.
        return explicit;
      }
      throw new Error(
        'platform: The claimed PostgreSQL database URL is missing from local recovery state. Export VOID_PLATFORM_DATABASE_URL with the original installation database before continuing.',
      );
    }
    if (explicit && explicit !== recorded) {
      throw new Error(
        'platform: This installation is already bound to its recorded PostgreSQL database. Unset DATABASE_URL and VOID_PLATFORM_DATABASE_URL before resuming; changing databases requires an explicit migration flow.',
      );
    }
    return recorded;
  }
  // A failed initial claim has no Cloudflare resource bound to the database,
  // so explicit operator input may correct an unreachable or mistyped URL.
  return explicit || recorded;
}

export async function runPlatformLifecycleCommand(args: PlatformArgs): Promise<void> {
  if (args.subcommand === 'domain') {
    const { runPlatformDomainCommand } = await import('./platform-domain.ts');
    await runPlatformDomainCommand(args);
    return;
  }
  if (args.subcommand === 'discover') {
    const credential = await resolvePlatformCloudflareCredential();
    const client = new PlatformCloudflareClient(credential.token);
    const accounts = await readAccounts(client);
    const accountId = await selectAccount(accounts, args.account);
    const { recoverPlatformInstallations } = await import('./platform-recovery.ts');
    const recovered = await recoverPlatformInstallations(
      client,
      accountId,
      undefined,
      args.selector,
    );
    if (recovered.length === 0) {
      log.info(`No recoverable Void platform installations were found in ${accountId}.`);
      return;
    }
    for (const manifest of recovered) {
      log.success(
        `Recovered ${manifest.deployment.displayName} (${manifest.id}) at ${manifest.endpoints.apiUrl}.`,
      );
    }
    return;
  }
  if (args.subcommand !== 'install') {
    const { runInstalledPlatformCommand } = await import('./platform-management.ts');
    await runInstalledPlatformCommand(args);
    return;
  }

  const runtime = loadPlatformRuntime(args.runtime);

  assertNoninteractivePlatformMutationAcknowledged(args, process.stdin.isTTY === true);

  console.log();
  intro(cliTitle('platform install'));
  const operatorCredential = await resolvePlatformCloudflareCredential();
  let client = new PlatformCloudflareClient(operatorCredential.token);
  let existing = args.resume ? resolveInstallationManifest(args.name) : null;
  let automaticDraft = false;
  if (!existing && !args.name && !args.resume) {
    const drafts = listInstallationManifests().filter(
      (manifest) =>
        isPlatformSetupDraft(manifest) &&
        (!args.account ||
          manifest.account.id === args.account ||
          manifest.account.name.toLowerCase() === args.account.toLowerCase()),
    );
    if (drafts.length === 1) {
      existing = drafts[0]!;
      automaticDraft = true;
      log.info('Continuing saved credential setup; your callback URL stays the same.');
    }
  }
  if (existing?.endpoints.apiUrl && !readPendingInstallationSecrets(existing)) {
    throw new Error(
      `platform: Installation ${existing.id} has already been deployed. Use \`void platform repair ${existing.id}\` or \`void platform upgrade ${existing.id}\` instead.`,
    );
  }
  const name =
    existing?.deployment.installationSlug ??
    (args.name || (await promptText('Installation name:', 'company')));
  const installationSlug = normalizeInstallationSlug(name);
  const accounts = await readAccounts(client);
  const accountId = existing ? existing.account.id : await selectAccount(accounts, args.account);
  if (
    existing &&
    args.account &&
    (await selectAccount(accounts, args.account)) !== existing.account.id
  ) {
    throw new Error('platform: The installation belongs to a different Cloudflare account.');
  }
  if (!existing) {
    existing =
      listInstallationManifests().find(
        (manifest) =>
          manifest.account.id === accountId &&
          manifest.deployment.installationSlug === installationSlug &&
          isPlatformSetupDraft(manifest),
      ) ?? null;
    automaticDraft = existing !== null;
    if (automaticDraft) {
      log.info('Continuing saved credential setup; your callback URL stays the same.');
    } else {
      assertPlatformInstallationSlugAvailable(installationSlug);
    }
  }
  const recorded = existing?.deployment;
  if (
    existing &&
    isPlatformSetupDraft(existing) &&
    ((args.applicationDomain &&
      normalizeApplicationDomain(args.applicationDomain) !== recorded!.application.baseDomain) ||
      (args.zone && normalizeApplicationDomain(args.zone) !== recorded!.application.zoneName) ||
      (args.workersDev && !!recorded!.application.zoneName) ||
      (args.controlPlaneDomain &&
        normalizeApplicationDomain(args.controlPlaneDomain) !==
          recorded!.controlPlane.apiHostname) ||
      (args.dedicatedZone && !recorded!.application.dedicatedZone))
  ) {
    throw new Error(
      'platform: These options differ from the saved setup. Resume its recorded configuration or choose another installation name.',
    );
  }
  let workersDev =
    (!!recorded?.application.workersDev && !recorded.application.zoneName) ||
    args.workersDev === true;
  if (
    !recorded &&
    !args.workersDev &&
    !args.applicationDomain &&
    !args.zone &&
    process.stdin.isTTY
  ) {
    const mode = await select({
      message: 'Where should your apps live?',
      options: [
        { value: 'domain', label: 'Use a domain', hint: 'recommended' },
        { value: 'workers-dev', label: 'Use workers.dev for testing', hint: 'add a domain later' },
      ],
    });
    if (isCancel(mode)) {
      throw new Error('platform: Cancelled.');
    }
    workersDev = mode === 'workers-dev';
  }
  const applicationDomain =
    recorded?.application.baseDomain ??
    (workersDev
      ? ''
      : normalizeApplicationDomain(
          args.applicationDomain || (await promptText('Application base domain:', 'example.app')),
        ));
  const zoneName =
    recorded?.application.zoneName ??
    (workersDev
      ? ''
      : normalizeApplicationDomain(
          args.zone || (await promptText('Cloudflare zone:', applicationDomain)),
        ));
  const displayName =
    recorded?.displayName ??
    (args.displayName || (await promptText('Platform display name:', `${installationSlug} Void`)));
  const controlPlaneDomain =
    recorded?.controlPlane.apiHostname ??
    (args.controlPlaneDomain ||
      (process.stdin.isTTY
        ? await promptText('Optional custom API hostname (leave empty for workers.dev):', '', true)
        : ''));
  let dedicatedZone = recorded?.application.dedicatedZone ?? args.dedicatedZone;
  if (
    !workersDev &&
    !recorded &&
    !args.dedicatedZone &&
    applicationDomain === zoneName &&
    process.stdin.isTTY
  ) {
    const catchAll = await confirm({
      message: `Dedicate all unmatched ${zoneName} traffic to Void apps?`,
      initialValue: false,
    });
    if (isCancel(catchAll) || typeof catchAll === 'symbol') {
      throw new Error('platform: Cancelled.');
    }
    dedicatedZone = catchAll;
  }
  const release = args.plan ? null : acquirePlatformLifecycleLock(accountId, installationSlug);
  try {
    if (!existing && !args.plan) {
      assertPlatformInstallationSlugAvailable(installationSlug);
    }
    if (existing && !args.plan) {
      existing = resolveInstallationManifest(existing.id);
      if (automaticDraft && !isPlatformSetupDraft(existing)) {
        throw new Error(
          'platform: Setup advanced in another process. Rerun with --resume to review its current state.',
        );
      }
    }
    const checkpoint = existing ? readPendingInstallationSecrets(existing) : null;
    const databaseUrl = resolvePlatformInstallDatabaseUrl(checkpoint, existing);
    let authoritativeProvisionIntents = false;
    if (existing && !isPlatformSetupDraft(existing)) {
      if (!databaseUrl) {
        throw new Error(
          'platform: DATABASE_URL is required to verify an interrupted installation before resuming it.',
        );
      }
      const authoritative = await readPlatformDatabaseLifecycleManifest(
        databaseUrl,
        existing.id,
        existing.ownershipNonce,
      );
      if (authoritative) {
        const { selectAuthoritativePlatformManifest } = await import('./platform-management.ts');
        const selected = selectAuthoritativePlatformManifest(existing, authoritative);
        authoritativeProvisionIntents = true;
        if (!args.plan && JSON.stringify(selected) !== JSON.stringify(existing)) {
          writeInstallationManifest(selected);
        }
        existing = selected;
      }
    }
    const planInput = {
      accountId,
      applicationDomain,
      controlPlaneDomain,
      dedicatedZone,
      displayName,
      installationSlug,
      zoneName,
      ...(workersDev ? { workersDev: true } : {}),
    };
    let plan = await createInitialPlatformInstallPlan(
      client,
      planInput,
      existing,
      authoritativeProvisionIntents,
      args.plan,
    );
    note(
      formatPlatformInstallPlan(plan),
      args.plan ? 'Read-only installation plan' : 'Installation plan',
    );
    note(formatPlatformRuntime(runtime), 'Platform runtime');
    if (args.plan) {
      console.log(formatPlatformSetupPlan(plan, existing !== null));
      outro('No Cloudflare or local installation state was changed.');
      return;
    }
    assertPlatformOperatorCredentialCanApplyPlan(operatorCredential, plan);
    if (process.stdin.isTTY && !args.yes) {
      const proceed = await confirm({ message: 'Apply this plan?', initialValue: false });
      if (isCancel(proceed) || !proceed) {
        outro('No changes made.');
        return;
      }
    }

    if (!existing) {
      existing = savePlatformSetupDraft(plan, runtime.manifest.platformVersion);
    }
    const credentialSetup = isPlatformSetupDraft(existing);
    const values: Record<string, string> = { ...checkpoint };
    const saveValues = (updates: Record<string, string>) => {
      Object.assign(values, updates);
      if (credentialSetup) {
        writePendingInstallationSecrets(existing!, values);
      }
    };
    const configured = (key: string, environment: string) =>
      credentialSetup
        ? process.env[environment] || values[key] || ''
        : values[key] || process.env[environment] || '';
    const collect = async (
      key: string,
      environment: string,
      message: string,
      masked = true,
      persist = true,
      validate?: (value: string) => string | undefined,
    ) => {
      const value = configured(key, environment) || (await promptSecret(message, masked, validate));
      const error = validate?.(value);
      if (error) {
        throw new Error('platform: ' + error);
      }
      if (persist) {
        saveValues({ [key]: value });
      }
      return value;
    };
    const pages = platformSetupPages(plan, true);
    if (!configured('cloudflareApiToken', 'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN')) {
      openPlatformSetupPage(pages.runtime);
    }

    const runtimeCloudflareApiToken = await collect(
      'cloudflareApiToken',
      'VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN',
      'Paste runtime API token:',
      true,
      false,
    );
    try {
      await verifyPlatformRuntimeTokenPermissions(
        new PlatformCloudflareClient(runtimeCloudflareApiToken),
        {
          accountId,
          applicationDomain,
          customDomains: plan.deployment.capabilities.customDomains,
          zoneId: plan.zone?.id ?? null,
        },
      );
      if (plan.actions.some((action) => action.action === 'inspect')) {
        client = client.withAiGatewayToken(runtimeCloudflareApiToken);
        plan = await verifyPlatformAiGatewayPlan(
          client,
          planInput,
          existing,
          plan,
          authoritativeProvisionIntents,
        );
      }
    } catch (error) {
      let cause: unknown = error;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++, cause = cause.cause) {
        if (
          credentialSetup &&
          cause instanceof PlatformCloudflareApiError &&
          [401, 403].includes(cause.status)
        ) {
          delete values.cloudflareApiToken;
          writePendingInstallationSecrets(existing, values);
          break;
        }
      }
      throw error;
    }
    saveValues({ cloudflareApiToken: runtimeCloudflareApiToken });
    const previousLogin = values.bootstrapGitHubLogin;
    const bootstrapGitHubLogin = await collect(
      'bootstrapGitHubLogin',
      'VOID_PLATFORM_ADMIN_GITHUB_LOGIN',
      'Initial administrator GitHub username:',
      false,
    );
    const bootstrapGitHubId =
      (previousLogin === bootstrapGitHubLogin ? values.bootstrapGitHubId : '') ||
      process.env.VOID_PLATFORM_ADMIN_GITHUB_ID ||
      (await resolveBootstrapGitHubId(bootstrapGitHubLogin));
    saveValues({ bootstrapGitHubId });
    const installationDatabaseUrl =
      databaseUrl ||
      (await collect('databaseUrl', 'VOID_PLATFORM_DATABASE_URL', 'PostgreSQL DATABASE_URL:'));
    saveValues({ databaseUrl: installationDatabaseUrl });
    if (
      !configured('githubClientId', 'VOID_PLATFORM_GITHUB_CLIENT_ID') ||
      !configured('githubClientSecret', 'VOID_PLATFORM_GITHUB_CLIENT_SECRET')
    ) {
      openPlatformSetupPage(
        configured('githubClientId', 'VOID_PLATFORM_GITHUB_CLIENT_ID')
          ? { ...pages.github, url: 'https://github.com/settings/developers' }
          : pages.github,
      );
    }
    const githubClientId = await collect(
      'githubClientId',
      'VOID_PLATFORM_GITHUB_CLIENT_ID',
      'GitHub OAuth client ID:',
      false,
      false,
    );
    const githubClientSecret = await collect(
      'githubClientSecret',
      'VOID_PLATFORM_GITHUB_CLIENT_SECRET',
      'GitHub OAuth client secret:',
      true,
      false,
    );
    saveValues({ githubClientId, githubClientSecret });
    if (
      !configured('r2AccessKeyId', 'VOID_PLATFORM_R2_ACCESS_KEY_ID') ||
      !configured('r2SecretAccessKey', 'VOID_PLATFORM_R2_SECRET_ACCESS_KEY')
    ) {
      openPlatformSetupPage(pages.r2);
    }
    const r2AccessKeyId = await collect(
      'r2AccessKeyId',
      'VOID_PLATFORM_R2_ACCESS_KEY_ID',
      'R2 access key ID:',
      false,
      false,
    );
    const r2SecretAccessKey = await collect(
      'r2SecretAccessKey',
      'VOID_PLATFORM_R2_SECRET_ACCESS_KEY',
      'R2 secret access key:',
      true,
      false,
    );
    saveValues({ r2AccessKeyId, r2SecretAccessKey });
    const hasFullProjectSecretKeyring = Boolean(
      checkpoint?.projectSecretKeysJson ||
      checkpoint?.projectSecretActiveKeyVersion ||
      process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON ||
      process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION,
    );
    const secrets = createPlatformInstallationSecrets({
      bootstrapGitHubId,
      bootstrapGitHubLogin,
      cloudflareApiToken: runtimeCloudflareApiToken,
      checkpoint: values,
      databaseUrl: installationDatabaseUrl,
      githubClientId,
      githubClientSecret,
      r2AccessKeyId,
      r2SecretAccessKey,
      existingInstallation: !credentialSetup,
      jwtSecret: await collect(
        'jwtSecret',
        'VOID_PLATFORM_JWT_SECRET',
        'JWT signing secret from your password manager (at least 32 random bytes):',
        true,
        true,
        credentialSetup
          ? (value) =>
              Buffer.byteLength(value, 'utf8') >= 32
                ? undefined
                : 'The JWT signing secret must contain at least 32 random bytes.'
          : undefined,
      ),
      projectSecretKey:
        configured('projectSecretKey', 'VOID_PLATFORM_PROJECT_SECRET_KEY') ||
        (hasFullProjectSecretKeyring
          ? ''
          : await collect(
              'projectSecretKey',
              'VOID_PLATFORM_PROJECT_SECRET_KEY',
              'Project encryption key from your password manager (base64, 32 bytes):',
              true,
              true,
              credentialSetup
                ? (value) => {
                    const key = Buffer.from(value, 'base64');
                    return key.length === 32 && key.toString('base64') === value
                      ? undefined
                      : 'The project encryption key must be canonical base64 encoding of exactly 32 bytes.';
                  }
                : undefined,
            )),
      projectSecretKeysJson: process.env.VOID_PLATFORM_PROJECT_SECRET_KEYS_JSON || '',
      projectSecretActiveKeyVersion:
        process.env.VOID_PLATFORM_PROJECT_SECRET_ACTIVE_KEY_VERSION || '',
    });
    if (credentialSetup) {
      // Stop treating this as an untouched local draft before any database claim is attempted.
      saveValues({ projectSecretKey: secrets.projectSecretKey });
      existing = completePlatformSetupDraft(existing);
    }
    const result = await installPlatform(plan, secrets, existing, {
      acquireDatabaseLifecycleLock: acquirePlatformDatabaseLifecycleLock,
      client,
      runtime,
      replanWorkers: async (manifest) =>
        (
          await createPlatformInstallPlan(client, planInput, manifest, {
            authoritativeProvisionIntents: true,
            repairMissing: true,
          })
        ).actions.filter((action) => action.kind === 'worker'),
      revalidateBeforeWorkerDeploy: (manifest, action) =>
        revalidatePlatformInstallAction(client, plan, manifest, action),
      verifyExistingOwnership: async (manifest, databaseCheckpointExists) => {
        const { verifyPlatformInstallationOwnership } = await import('./platform-management.ts');
        const retainedReplacementKeys = new Set(
          plan.actions
            .filter((action) => {
              const previous = manifest.resources.find((resource) => resource.key === action.key);
              return action.action === 'create' && previous && previous.name !== action.name;
            })
            .map((action) => action.key),
        );
        await verifyPlatformInstallationOwnership(client, manifest, {
          allowUninitializedRoutingCheckpoint: databaseCheckpointExists,
          databaseUrl: secrets.databaseUrl,
          retainedReplacementKeys,
        });
      },
    });
    if (result.waitingForDns) {
      note(
        result.zoneNameServers.length > 0
          ? `Update the domain at your registrar to use:\n${result.zoneNameServers.join('\n')}\n\nThen rerun: void platform install --resume --name ${result.manifest.id}`
          : `Wait for ${zoneName} to become active, then rerun:\nvoid platform install --resume --name ${result.manifest.id}`,
        'Waiting for nameservers',
      );
      outro(`Installation ${result.manifest.id} is safely checkpointed.`);
      return;
    }
    if (result.waitingForSandboxDrain) {
      note(
        "The compatible candidate runtime is live in sandbox-drain maintenance mode and application traffic remains disabled. Preview bounded work with `void platform system sandbox-drain --plan`; follow any returned `nextCursor` with `--cursor '<value>'`. Then apply with `void platform system sandbox-drain --yes` and rerun until it reports DB-backed `complete: true`. Rerun this install command afterward to enable traffic.",
        'Waiting for managed Sandbox drain',
      );
      outro(`Installation ${result.manifest.id} is safely checkpointed.`);
      return;
    }
    log.success(`${result.manifest.deployment.displayName} is installed at ${plan.apiUrl}.`);
    if (!plan.deployment.application.zoneName) {
      log.info(
        'Apps will use workers.dev addresses. When your domain is ready: void platform domain set <domain>',
      );
    }
    outro('Run `void auth login`, then deploy an app with `void deploy --platform void`.');
  } catch (error) {
    if (existing && !args.plan) {
      log.info('Continue with: void platform install --resume --name ' + existing.id);
    }
    throw error;
  } finally {
    release?.();
  }
}

function formatPlatformRuntime(runtime: ReturnType<typeof loadPlatformRuntime>): string {
  return [
    `Version: ${runtime.manifest.platformVersion}`,
    `Source: ${runtime.source}`,
    `Revision: ${runtime.manifest.sourceRevision ?? 'not recorded'}`,
    `Manifest SHA-256: ${runtime.manifestSha256}`,
  ].join('\n');
}

export async function verifyPlatformAiGatewayPlan(
  client: Parameters<typeof createPlatformInstallPlan>[0],
  input: Parameters<typeof createPlatformInstallPlan>[1],
  existing: PlatformInstallationManifest | null,
  preview: Awaited<ReturnType<typeof createPlatformInstallPlan>>,
  authoritativeProvisionIntents: boolean,
): Promise<Awaited<ReturnType<typeof createPlatformInstallPlan>>> {
  let verified: Awaited<ReturnType<typeof createPlatformInstallPlan>>;
  try {
    verified = await createPlatformInstallPlan(client, input, existing, {
      authoritativeProvisionIntents,
      provisioningSuffix: preview.provisioningSuffix,
    });
  } catch (error) {
    if (
      error instanceof PlatformCloudflareApiError &&
      (error.status === 401 || error.status === 403) &&
      error.requestPath?.includes('/ai-gateway/')
    ) {
      throw new Error(
        'platform: The runtime token could not verify AI Gateway access. Include Account → AI Gateway → Edit for this account, then retry. No platform resources were created.',
        { cause: error },
      );
    }
    throw error;
  }
  const infrastructure = (plan: typeof preview) =>
    plan.actions
      .filter((action) => action.kind !== 'ai-gateway')
      .map(({ action, id, key, kind, name }) => ({ action, id, key, kind, name }));
  if (
    verified.installationId !== preview.installationId ||
    JSON.stringify(verified.deployment) !== JSON.stringify(preview.deployment) ||
    JSON.stringify(infrastructure(verified)) !== JSON.stringify(infrastructure(preview))
  ) {
    throw new Error(
      'platform: Resources changed while checking AI Gateway access. Rerun the command to review the updated plan. No platform resources were created.',
    );
  }
  return verified;
}

export function assertNoninteractivePlatformMutationAcknowledged(
  args: PlatformArgs,
  interactive: boolean,
): void {
  if (
    args.subcommand === 'list' ||
    args.subcommand === 'use' ||
    args.subcommand === 'status' ||
    args.subcommand === 'discover' ||
    args.plan ||
    interactive ||
    args.yes
  ) {
    return;
  }
  throw new Error(
    `platform: Non-interactive \`void platform ${args.subcommand}\` requires --yes to acknowledge Cloudflare changes. Run with --plan first to inspect them.`,
  );
}

async function createInitialPlatformInstallPlan(
  client: PlatformCloudflareClient,
  input: Parameters<typeof createPlatformInstallPlan>[1],
  existing: PlatformInstallationManifest | null,
  authoritativeProvisionIntents: boolean,
  planOnly: boolean,
): Promise<Awaited<ReturnType<typeof createPlatformInstallPlan>>> {
  if (existing || planOnly) {
    return createPlatformInstallPlan(client, input, existing, {
      authoritativeProvisionIntents,
      allowUnverifiedAiGateway: true,
    });
  }
  let collision: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await createPlatformInstallPlan(client, input, null, {
        authoritativeProvisionIntents,
        allowUnverifiedAiGateway: true,
        // A fresh apply receives a 128-bit resource namespace. Independent installers
        // therefore cannot accidentally choose the same Worker name during the API's
        // non-atomic create precondition window; installers resuming the SAME installation
        // are serialized by the PostgreSQL lifecycle lock. An account principal deliberately
        // targeting this exact random name already has authority to replace it after install.
        provisioningSuffix: randomBytes(16).toString('hex'),
      });
    } catch (error) {
      if (!String(error).includes('already exists but is not owned by this installation')) {
        throw error;
      }
      collision = error;
    }
  }
  throw new Error('platform: Could not allocate collision-free platform resource names.', {
    cause: collision,
  });
}

async function readAccounts(
  client: PlatformCloudflareClient,
): Promise<ReadonlyArray<CloudflareAccount>> {
  // Listing authorized accounts works for browser OAuth and both account- and
  // user-scoped API tokens. /user/tokens/verify only understands the latter.
  const accounts = await client.listAccounts();
  if (accounts.length === 0) {
    throw new Error('platform: This Cloudflare token has no accessible accounts.');
  }
  return accounts;
}

async function selectAccount(
  accounts: ReadonlyArray<CloudflareAccount>,
  selector: string,
): Promise<string> {
  if (selector) {
    const matches = accounts.filter(
      (account) => account.id === selector || account.name.toLowerCase() === selector.toLowerCase(),
    );
    if (matches.length !== 1) {
      throw new Error(
        `platform: Cloudflare account ${JSON.stringify(selector)} is ambiguous or unavailable.`,
      );
    }
    return matches[0]!.id;
  }
  if (accounts.length === 1) {
    return accounts[0]!.id;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'platform: --account <id> is required when the token can access multiple accounts.',
    );
  }
  const value = await select({
    message: 'Cloudflare account:',
    options: accounts.map((account) => ({
      label: account.name,
      value: account.id,
      hint: account.id,
    })),
  });
  if (isCancel(value)) {
    throw new Error('platform: Cancelled.');
  }
  return String(value);
}

async function promptText(
  message: string,
  initialValue: string,
  optional = false,
): Promise<string> {
  if (!process.stdin.isTTY) {
    if (optional) {
      return '';
    }
    throw new Error(`platform: ${message.replace(/:$/, '')} is required in non-interactive mode.`);
  }
  const value = await text({
    message,
    initialValue,
    validate: optional ? undefined : (input) => (input ? undefined : 'A value is required.'),
  });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}

async function promptSecret(
  message: string,
  masked = true,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `platform: ${message.replace(/:$/, '')} is required in non-interactive mode. Set the documented VOID_PLATFORM_* environment variable.`,
    );
  }
  const value = masked
    ? await password({
        message,
        validate: (input) => (input ? validate?.(input) : 'A value is required.'),
      })
    : await text({ message, validate: (input) => (input ? undefined : 'A value is required.') });
  if (isCancel(value) || typeof value === 'symbol') {
    throw new Error('platform: Cancelled.');
  }
  return value;
}
