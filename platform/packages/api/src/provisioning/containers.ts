import { retryWithBackoff } from '../cf-api.ts';
import { CF_API_BASE, cfFetch, CloudflareApiError } from './cloudflare-api.ts';

export type ContainerApplicationInfo = Readonly<{
  id: string;
  name: string;
  scheduling_policy?: string;
  configuration?: {
    image?: string;
    instance_type?: string;
  };
  durable_objects?: {
    namespace_id?: string;
  };
  max_instances?: number;
}>;

export type SandboxContainerConfig = Readonly<{
  name: string;
  image: string;
  namespaceId: string;
  instanceType?: string;
  maxInstances?: number;
}>;

type ScriptBinding = Readonly<{
  type: string;
  name?: string;
  class_name?: string;
  namespace_id?: string;
}>;

/**
 * Resolve a Durable Object namespace ID for a class on a WfP script.
 *
 * Reads the script's own bindings (per-script endpoint) instead of paging the
 * account-wide `/workers/durable_objects/namespaces` listing. The listing
 * endpoint is global, doesn't accept a working `script` filter (CF ignores it
 * silently), and races against propagation lag for new WfP scripts. The
 * per-script bindings endpoint returns `namespace_id` directly the moment the
 * script is uploaded, so the caller's retry loop only ever waits for the
 * worker upload step itself to be visible — not for the global list to
 * eventually-consist.
 */
export async function findDurableObjectNamespaceId(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  scriptName: string,
  bindingName: string,
  className: string,
): Promise<string> {
  const bindings = await cfFetch<ReadonlyArray<ScriptBinding>>(
    `${CF_API_BASE}/${accountId}/workers/dispatch/namespaces/${dispatchNamespace}/scripts/${scriptName}/bindings`,
    apiToken,
  );

  const match = bindings.find(
    (binding) =>
      binding.type === 'durable_object_namespace' &&
      binding.name === bindingName &&
      binding.class_name === className &&
      typeof binding.namespace_id === 'string',
  );

  if (!match || !match.namespace_id) {
    throw new Error(
      `Durable Object namespace binding not found on ${dispatchNamespace}/${scriptName} for ${bindingName}=${className}`,
    );
  }

  return match.namespace_id;
}

export async function deleteContainerApplication(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  await cfFetch(`${containersUrl(accountId)}/applications/${applicationId}`, apiToken, {
    method: 'DELETE',
  });
}

/**
 * Idempotent variant of {@link deleteContainerApplication}. Swallows 404
 * responses (the application is already gone) and re-throws any other error.
 * Used by the deploy pipeline and project teardown to make repeated DELETE
 * attempts safe under partial-failure replay.
 */
export async function deleteContainerApplicationIdempotent(
  accountId: string,
  apiToken: string,
  applicationId: string,
): Promise<void> {
  try {
    await deleteContainerApplication(accountId, apiToken, applicationId);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) {
      return;
    }
    throw err;
  }
}

/**
 * POST a new container application. Returns the created app on success, or
 * `undefined` if CF reports the app already exists (i.e. a concurrent deploy
 * won the race) so the caller can fall back to PATCH. Any other error
 * propagates.
 *
 * Status 409 is the authoritative race signal; message matching is a
 * defense-in-depth fallback for non-conventional responses where CF returns a
 * different status but the body still says "already exists".
 */
export async function tryCreateContainerApplication(
  accountId: string,
  apiToken: string,
  config: SandboxContainerConfig,
): Promise<ContainerApplicationInfo | undefined> {
  const createBody = {
    name: config.name,
    scheduling_policy: 'default',
    configuration: {
      image: config.image,
      instance_type: config.instanceType ?? 'lite',
    },
    instances: 0,
    max_instances: config.maxInstances ?? 20,
    durable_objects: { namespace_id: config.namespaceId },
    rollout_active_grace_period: 0,
  };

  try {
    return await cfFetch<ContainerApplicationInfo>(
      `${containersUrl(accountId)}/applications`,
      apiToken,
      {
        method: 'POST',
        body: JSON.stringify(createBody),
      },
    );
  } catch (err) {
    // Authoritative: HTTP 409 means concurrent-create race regardless of body.
    if (err instanceof CloudflareApiError && err.status === 409) {
      return undefined;
    }
    // Defense-in-depth: some CF endpoints return non-409 statuses but still
    // signal the conflict in the message body.
    if (err instanceof Error && isAlreadyExistsError(err.message)) {
      return undefined;
    }
    throw err;
  }
}

// Intentionally does not match the bare word 'conflict' — it appears in unrelated CF validation errors (e.g. "configuration conflicts with durable object namespace") and would cause a false-positive race fallback.
function isAlreadyExistsError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('already exists') || lower.includes('duplicate');
}

export async function findContainerApplication(
  accountId: string,
  apiToken: string,
  name: string,
): Promise<ContainerApplicationInfo | undefined> {
  const applications = await cfFetch<ReadonlyArray<ContainerApplicationInfo>>(
    `${containersUrl(accountId)}/applications?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  return applications.find((application) => application.name === name);
}

function containersUrl(accountId: string): string {
  return `${CF_API_BASE}/${accountId}/containers`;
}

/**
 * Compute the per-deploy CF container application name. The deployment id is
 * baked in so each deploy gets a globally-unique name — the per-deploy
 * architecture relies on every POST creating a fresh app (one DO namespace
 * can only ever bind to one container app, and each deploy mints a fresh
 * namespace via its own `Sandbox` class declaration).
 *
 * Lowercased and underscores converted to dashes because CF container names
 * reject uppercase / `_`.
 */
export function perDeployContainerApplicationName(
  projectId: string,
  deploymentId: string,
  containerName: string,
): string {
  return `${projectId}-${deploymentId}-${containerName}`.toLowerCase().replaceAll('_', '-');
}

/**
 * After the per-deploy user worker has been PUT to the dispatch namespace,
 * look up its fresh DO namespace_id and POST a new container application
 * bound to it. Each deploy creates a new container; old ones are deleted by
 * the retention loop.
 *
 * Container app name: `${projectId}-${deploymentId}-${containerName}` (lowercased,
 * underscores → dashes — CF container names reject uppercase / `_`).
 *
 * Returns the namespace id and the new container application id, ready for
 * the deploy pipeline to UPSERT the resources row.
 *
 * Wraps the namespace probe in retry/backoff to absorb CF's brief
 * post-PUT propagation lag on the per-script bindings endpoint.
 */
export async function provisionPerDeployContainer(
  accountId: string,
  apiToken: string,
  dispatchNamespace: string,
  workerScriptName: string,
  containerAppName: string,
  bindingName: string,
  className: string,
  sandbox: { image: string; instanceType?: string; maxInstances?: number },
): Promise<{ namespaceId: string; containerApplicationId: string }> {
  const namespaceId = await retryWithBackoff(
    async () => {
      try {
        return await findDurableObjectNamespaceId(
          accountId,
          apiToken,
          dispatchNamespace,
          workerScriptName,
          bindingName,
          className,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[per-deploy-container] namespace probe miss for ${workerScriptName} (will retry): ${msg}`,
        );
        return undefined;
      }
    },
    {
      maxRetries: 8,
      delayMs: 500,
      errorMessage: `per-deploy DO namespace was not visible after worker PUT (script=${workerScriptName})`,
    },
  );

  const created = await tryCreateContainerApplication(accountId, apiToken, {
    name: containerAppName,
    image: sandbox.image,
    namespaceId,
    instanceType: sandbox.instanceType,
    maxInstances: sandbox.maxInstances,
  });

  if (!created) {
    // 409 here is recoverable iff the existing app is bound to the same
    // namespace_id we just resolved — that means a previous attempt of this
    // same deploy POSTed the app but threw before recording the id. Reusing
    // it is safe. Any other state (different namespace, or vanished entirely)
    // signals a real collision or concurrent deletion and must not be papered
    // over.
    const existing = await findContainerApplication(accountId, apiToken, containerAppName);
    if (!existing) {
      throw new Error(
        `per-deploy container application "${containerAppName}" POST returned 409 ` +
          `but a follow-up lookup found no application by that name`,
      );
    }
    if (existing.durable_objects?.namespace_id !== namespaceId) {
      throw new Error(
        `per-deploy container application "${containerAppName}" already exists but is bound to ` +
          `namespace_id=${existing.durable_objects?.namespace_id ?? '<none>'} ` +
          `instead of expected ${namespaceId}; refusing to reuse`,
      );
    }
    return { namespaceId, containerApplicationId: existing.id };
  }

  return { namespaceId, containerApplicationId: created.id };
}
