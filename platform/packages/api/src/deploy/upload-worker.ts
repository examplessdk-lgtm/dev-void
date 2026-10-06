import { eq } from 'drizzle-orm';
import { type Context } from 'hono';
import {
  createAssetUploadSession,
  normalizeForCfAssetSession,
  uploadAssetBuckets,
  buildAssetMetadata,
  resolveAssetContentTypes,
  type AssetManifestEntry,
} from '../assets.ts';
import { retryWithBackoff } from '../cf-api.ts';
import { uploadPool } from '../concurrency.ts';
import { getProjectSecrets, upsertProjectSecret } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { type DeployLogger } from '../observability/logger.ts';
import {
  BETTER_AUTH_SECRET_NAME,
  decryptProjectSecret,
  generateManagedAuthSecret,
  encryptProjectSecret,
} from '../project-secrets.ts';
import { provisionBindings } from '../provisioning/provision.ts';
import {
  provisionSandboxController,
  sandboxControllerWorkerName,
} from '../provisioning/sandbox-controller.ts';
import { RESERVED_BINDING_NAMES } from '../reserved-bindings.ts';
import { deployments } from '../schema.ts';
import { type DeployManifest, type DeployEvent, type Deployment, type Project } from '../types.ts';
import {
  buildWebSocketUploadBindings,
  buildSandboxUploadBindings,
  buildLiveUploadBindings,
  buildDurableObjectUploadMigrations,
} from './durable-bindings.ts';
import { assertDeploymentCanProceed } from './guards.ts';
import { isCfAssetPlainText } from './migrations.ts';
import { StaticAssetDisappearedError, attachServingStoreMetadata } from './serving-assets.ts';
import { R2_HEAD_VERIFY_CONCURRENCY, DEFAULT_TAIL_SERVICE_NAME, CF_RETRY } from './shared.ts';

export async function uploadDeploymentWorker(input: {
  currentStep: string;
  readonly markPhase: (next: string) => void;
  readonly manifest: DeployManifest;
  readonly emit: (event: DeployEvent) => void;
  readonly context: Context<ApiEnv>;
  readonly projectId: string;
  readonly project: Project;
  readonly deployment: Deployment;
  readonly assetCount: number;
  readonly deployedAssetCount: number;
  readonly dispatchNamespace: string;
  readonly workerName: string;
  readonly assetManifest: Record<string, AssetManifestEntry>;
  readonly logger: DeployLogger;
  readonly assetsByHash: Map<string, Readonly<{ bytes: Uint8Array; contentType: string }>>;
  readonly incomingAssetManifest: Record<string, AssetManifestEntry>;
  wfpMirroredManifestDeploymentId: string | null;
  readonly workerFiles: Array<{ name: string; content: Blob }>;
  sandboxControllerAttempted: boolean;
  readonly owner: ApiEnv['Variables']['user'];
  workerUploadUrl: string | undefined;
  workerUploaded: boolean;
}) {
  const {
    markPhase,
    manifest,
    emit,
    context,
    projectId,
    project,
    deployment,
    assetCount,
    deployedAssetCount,
    dispatchNamespace,
    workerName,
    assetManifest,
    logger,
    assetsByHash,
    incomingAssetManifest,
    workerFiles,
    owner,
  } = input;

  input.currentStep = 'provisioning';
  markPhase('provisioning');

  const bindingLabels: Array<string> = [];
  for (const name of manifest.bindings.d1 ?? []) {
    bindingLabels.push(`d1:${name}`);
  }
  for (const name of manifest.bindings.kv ?? []) {
    bindingLabels.push(`kv:${name}`);
  }
  for (const name of manifest.bindings.r2 ?? []) {
    bindingLabels.push(`r2:${name}`);
  }
  for (const queue of manifest.queues ?? []) {
    bindingLabels.push(`queue:${queue.name}`);
  }
  if (bindingLabels.length > 0) {
    emit({ event: 'provisioning', bindings: bindingLabels });
  }

  const workerBindings = await provisionBindings(
    context.get('db'),
    context.env.CF_ACCOUNT_ID,
    context.env.CF_API_TOKEN,
    projectId,
    manifest,
    context.env.JWT_SECRET,
    context.env.VOID_PROXY_SERVICE ?? 'void-proxy',
    {
      projectSlug: project.slug,
      emailSenderDomain: context.env.EMAIL_SENDER_DOMAIN,
      deploymentId: deployment.id,
    },
  );
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

  if (bindingLabels.length > 0) {
    emit({ event: 'provisioning_done' });
  }

  if (typeof manifest.vars?.[BETTER_AUTH_SECRET_NAME] === 'string') {
    throw new Error(
      `${BETTER_AUTH_SECRET_NAME} must be configured via project secrets, not manifest.vars`,
    );
  }

  let projectSecretRows = await getProjectSecrets(context.get('db'), projectId);
  if (manifest.auth) {
    const existingAuthSecret = projectSecretRows.find(
      (row) => row.name === BETTER_AUTH_SECRET_NAME,
    );
    if (!existingAuthSecret) {
      const managedSecret = generateManagedAuthSecret();
      const encrypted = await encryptProjectSecret(
        context.env,
        projectId,
        BETTER_AUTH_SECRET_NAME,
        managedSecret,
      );
      await upsertProjectSecret(
        context.get('db'),
        projectId,
        BETTER_AUTH_SECRET_NAME,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.keyVersion,
        'auth-default',
      );
      projectSecretRows = await getProjectSecrets(context.get('db'), projectId);
    }
  }
  const secretBindings = await Promise.all(
    projectSecretRows.map(async (row) => ({
      type: 'secret_text' as const,
      name: row.name,
      text: await decryptProjectSecret(context.env, projectId, row),
    })),
  );

  let completionJwt: string | undefined;
  if (assetCount > 0) {
    input.currentStep = 'asset_upload';
    markPhase('asset_upload');
    const session = await createAssetUploadSession(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      dispatchNamespace,
      workerName,
      // Strip extras (e.g. v2 `blake3`/`md5`) at the CF API boundary —
      // CF documents only `{ hash, size }` and may strictly validate.
      normalizeForCfAssetSession(assetManifest),
    );
    logger.info('asset_upload', 'session_created', {
      manifestEntries: Object.keys(assetManifest).length,
      buckets: session.buckets.length,
      blobsAvailable: assetsByHash.size,
    });

    // Every declared asset was verified in scoped R2 before provisioning.
    // Hydrate only the bytes Cloudflare actually requests; the cachebuster
    // already has its deploy-local bytes in assetsByHash.
    const hashesNeedingBytes = Array.from(new Set(session.buckets.flat())).filter(
      (hash) => !assetsByHash.has(hash),
    );
    const contentTypes = resolveAssetContentTypes(incomingAssetManifest, hashesNeedingBytes);
    await uploadPool(hashesNeedingBytes, R2_HEAD_VERIFY_CONCURRENCY, async (hash) => {
      const object = await context.env.STATIC_ASSETS_R2.get(`assets/${projectId}/${hash}`);
      if (!object) {
        throw new StaticAssetDisappearedError([hash]);
      }
      assetsByHash.set(hash, {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: contentTypes.get(hash)!,
      });
    });
    // Every byte was pre-uploaded direct-to-R2 by the CLI, so none are new
    // to this request.
    emit({
      event: 'asset_upload',
      total: deployedAssetCount,
      new: 0,
      cached: deployedAssetCount,
    });

    completionJwt = await uploadAssetBuckets(
      context.env.CF_ACCOUNT_ID,
      session.jwt,
      session.buckets,
      assetsByHash,
    );
    await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
    logger.info('asset_upload', 'upload_complete', {
      hasCompletionJwt: completionJwt !== undefined,
    });
    emit({ event: 'asset_upload_done' });

    // Mirror serving manifest. Direct-to-R2 already lands assets
    // in our R2; we just need to write the per-deploy serving
    // manifest so dispatch's WfP fallback can read them when CF's
    // asset store returns the dedupe-poisoning stub.
    const servingManifest = Object.fromEntries(
      Object.entries(assetManifest)
        .filter(([path]) => !path.startsWith('/.void-deploy/'))
        .map(([path, entry]) => [path, `!${entry.hash}`]),
    );
    const persistedAssetManifest = attachServingStoreMetadata(assetManifest, servingManifest, true);
    // Persist exact placement before the serving manifest/ready marker.
    // GC protects every nonterminal row with asset_hashes, and recovery
    // can reconstruct a lagging KV manifest without probing 5,000 keys.
    await context
      .get('db')
      .update(deployments)
      .set({ asset_hashes: JSON.stringify(persistedAssetManifest) })
      .where(eq(deployments.id, deployment.id));
    await context.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));
    input.wfpMirroredManifestDeploymentId = deployment.id;
  }

  input.currentStep = 'worker_upload';
  markPhase('worker_upload');
  const workerFormData = new FormData();
  emit({ event: 'worker_upload', modules: workerFiles.length });

  // Reserved-name set lives in `../reserved-bindings.ts` so the secrets
  // route can reject before persisting; see the invariant test there.
  const userVarNames = Object.keys(manifest.vars ?? {});
  const userSecretNames = secretBindings.map((s) => s.name);
  // Check BOTH vars and project secrets. A secret is uploaded in the
  // same `metadata.bindings` array, so a secret named e.g. `SEND_EMAIL`
  // or `__VOID_PROJECT_SLUG` either shadows a platform binding or is
  // shadowed by one — CF resolves duplicates last-wins with no error.
  // The secrets route rejects these at PUT time, but older stored rows
  // can still reach here. Failing the deploy with
  // a named binding beats shipping a worker that silently reads the
  // wrong value.
  const reserved = [
    ...userVarNames.filter((n) => RESERVED_BINDING_NAMES.has(n)).map((n) => `vars.${n}`),
    ...userSecretNames.filter((n) => RESERVED_BINDING_NAMES.has(n)).map((n) => `secret.${n}`),
  ];
  if (reserved.length > 0) {
    throw new Error(`reserved binding names: ${reserved.join(', ')}`);
  }
  const secretNames = new Set(userSecretNames);
  const collisions = userVarNames.filter((n) => secretNames.has(n));
  if (collisions.length > 0) {
    logger.warn('worker_upload', 'var_secret_collisions', { collisions });
  }
  const plainTextBindings = Object.entries(manifest.vars ?? {}).map(([name, text]) => ({
    type: 'plain_text' as const,
    name,
    text,
  }));
  const websocketBindings = buildWebSocketUploadBindings(manifest.websocket);
  if (manifest.sandbox) {
    input.currentStep = 'sandbox_container';
    markPhase('sandbox_container');
    input.sandboxControllerAttempted = true;
    await provisionSandboxController({
      accountId: context.env.CF_ACCOUNT_ID,
      apiToken: context.env.CF_API_TOKEN,
      apiService: context.env.SANDBOX_CONTROL_SERVICE ?? 'void-api',
      identity: {
        projectId: projectId,
        deploymentId: deployment.id,
        userId: owner.id,
        slug: project.slug,
      },
      sandbox: manifest.sandbox,
    });
    await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
  }
  const sandboxBindings = buildSandboxUploadBindings(
    manifest.sandbox,
    sandboxControllerWorkerName(projectId, deployment.id),
  );
  const liveBindings = buildLiveUploadBindings(manifest.live);
  // No per-project `send_email` binding is uploaded. The framework's
  // `sendEmail()` POSTs MIME + recipients to `__VOID_PROXY/email/send`;
  // the proxy holds the account-level send_email binding and enforces
  // the per-project verified-destination policy through SQL admission. See
  // `meta/design-docs/0078-email-cf-native.md` and `packages/proxy/src/email.ts`.
  const allBindings = [
    ...plainTextBindings,
    ...secretBindings,
    ...workerBindings,
    ...websocketBindings,
    ...sandboxBindings,
    ...liveBindings,
    ...(completionJwt ? [{ name: 'ASSETS', type: 'assets' }] : []),
  ];

  if (!manifest.compatibilityDate) {
    logger.warn('worker_upload', 'missing_compatibility_date');
  }
  const assetConfig = manifest.assetConfig ?? { not_found_handling: 'none' };
  const durableObjectMigrations = buildDurableObjectUploadMigrations(
    manifest.websocket?.migrations,
    manifest.live?.migrations,
  );
  const tailServiceName = context.env.TAIL_SERVICE_NAME ?? DEFAULT_TAIL_SERVICE_NAME;
  const metadata: Record<string, unknown> = {
    main_module: manifest.workerMain ?? 'index.js',
    compatibility_date: manifest.compatibilityDate ?? '2026-02-12',
    compatibility_flags: manifest.compatibilityFlags ?? ['nodejs_compat'],
    bindings: allBindings,
    ...(durableObjectMigrations ? { migrations: durableObjectMigrations } : {}),
    ...(completionJwt ? { assets: buildAssetMetadata(completionJwt, assetConfig) } : {}),
    observability: {
      enabled: true,
      logs: { invocation_logs: true, head_sampling_rate: 1 },
    },
    tail_consumers: [{ service: tailServiceName }],
  };
  workerFormData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
  );
  for (const file of workerFiles) {
    workerFormData.append(file.name, file.content, file.name);
  }

  input.workerUploadUrl = `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${workerName}`;
  await retryWithBackoff(
    async (attempt) => {
      const attemptStart = Date.now();
      const cfResponse = await fetch(input.workerUploadUrl!, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` },
        body: workerFormData,
      });

      if (!cfResponse.ok) {
        const error = await cfResponse.text();
        logger.error('worker_upload', 'attempt_failed', new Error(error), {
          attempt,
          maxAttempts: CF_RETRY.maxRetries + 1,
          latencyMs: Date.now() - attemptStart,
          status: cfResponse.status,
          bodyPreview: error.slice(0, 500),
        });
        throw new Error(`worker upload failed: ${error}`);
      }

      const cfBody = await cfResponse.text();
      if (isCfAssetPlainText(cfBody)) {
        logger.warn('worker_upload', 'attempt_failed', {
          attempt,
          maxAttempts: CF_RETRY.maxRetries + 1,
          latencyMs: Date.now() - attemptStart,
          code: 'cf_plain_text',
          bodyPreview: cfBody.slice(0, 100),
        });
        return undefined;
      }
      return true;
    },
    {
      ...CF_RETRY,
      errorMessage: 'worker upload returned an unexpected Cloudflare response',
    },
  );
  input.workerUploaded = true;

  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

  emit({ event: 'worker_upload_done' });
  return { workerBindings, assetConfig };
}
