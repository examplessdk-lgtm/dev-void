import { eq } from 'drizzle-orm';
import { hmacSignState } from '../auth/hmac.ts';
import { getProjectResources, createResource, type Db } from '../db.ts';
import { getProjectQueueName } from '../naming.ts';
import { resources as resourcesTable } from '../schema.ts';
import type { DeployManifest, Resource } from '../types.ts';
import {
  createD1Database,
  createKVNamespace,
  createR2Bucket,
  createQueue,
  deleteD1Database,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
  getQueueByName,
} from './cloudflare-api.ts';

export type WorkerBinding = Readonly<{
  type: 'd1' | 'kv_namespace' | 'r2_bucket' | 'queue' | 'service' | 'plain_text' | 'hyperdrive';
  name: string;
  id?: string;
  namespace_id?: string;
  bucket_name?: string;
  queue_name?: string;
  queue_id?: string;
  service?: string;
  text?: string;
}>;

export async function provisionBindings(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  manifest: DeployManifest,
  jwtSecret: string,
  aiProxyService: string,
  /**
   * Per-project platform identity injected into every worker. Grouped into
   * an object rather than two more trailing strings — `projectId`,
   * `accountId`, `apiToken` and `projectSlug` are all bare strings, and a
   * transposed pair would provision against the wrong project silently.
   */
  platform: {
    /** Project slug. Framework reads it as `__VOID_PROJECT_SLUG`. */
    projectSlug: string;
    /**
     * Platform mail domain for this environment (`EMAIL_SENDER_DOMAIN` on
     * the api worker — `mail.void.cloud` in production,
     * `mail.staging.void.cloud` in staging). Never hard-coded: the proxy
     * validates outbound senders against its own copy of the same value,
     * so a baked-in production domain would make staging unsendable.
     *
     * Optional so a deployment environment with email unconfigured still
     * deploys. When absent the binding is omitted entirely rather than
     * injected empty — the framework's `sendEmail`/`replyEmail` then fail
     * naming `__VOID_EMAIL_DOMAIN`, which is a far better error than a
     * malformed `slug+noreply@` the proxy rejects for a different reason.
     */
    emailSenderDomain?: string;
  },
): Promise<ReadonlyArray<WorkerBinding>> {
  const existing = await getProjectResources(db, projectId);

  // Run all CF API provisioning calls in parallel
  const tasks: Array<Promise<WorkerBinding>> = [];

  for (const name of manifest.bindings.d1 ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'd1', name, existing).then(
        (r): WorkerBinding => ({ type: 'd1', name, id: r.cf_id }),
      ),
    );
  }

  for (const name of manifest.bindings.kv ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'kv', name, existing).then(
        (r): WorkerBinding => ({ type: 'kv_namespace', name, namespace_id: r.cf_id }),
      ),
    );
  }

  for (const name of manifest.bindings.r2 ?? []) {
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'r2', name, existing).then(
        (r): WorkerBinding => ({ type: 'r2_bucket', name, bucket_name: r.cf_id }),
      ),
    );
  }

  for (const q of manifest.queues ?? []) {
    const queueName = getProjectQueueName(projectId, q.name);
    tasks.push(
      ensureResource(db, accountId, apiToken, projectId, 'queue', q.name, existing).then(
        (r): WorkerBinding => ({
          type: 'queue',
          name: q.bindingName,
          queue_name: queueName,
          queue_id: r.cf_id,
        }),
      ),
    );
  }

  for (const name of manifest.bindings.hyperdrive ?? []) {
    const found = existing.find((r) => r.type === 'hyperdrive' && r.binding_name === name);
    if (!found) {
      throw new Error(
        `Hyperdrive not provisioned for binding "${name}". Run \`void db set-url\` first.`,
      );
    }
    tasks.push(Promise.resolve({ type: 'hyperdrive' as const, name, id: found.cf_id }));
  }

  const bindings = await Promise.all(tasks);

  // Always inject proxy bindings — used by AI, revalidation, email, and future
  // platform features. The AI-specific usage limit check stays in the proxy
  // (/ai/* middleware).
  const proxyToken = await hmacSignState(projectId, jwtSecret);
  bindings.push({ type: 'service', name: '__VOID_PROXY', service: aiProxyService });
  bindings.push({ type: 'plain_text', name: '__PROJECT_ID', text: projectId });
  bindings.push({ type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: proxyToken });
  // Project slug — the SINGLE producer of `__VOID_PROJECT_SLUG`. It used to
  // be emitted by `buildSandboxIdentityBindings` for sandbox projects only;
  // `void/email` needs it on every worker to default an outbound `from` to
  // `<slug>+noreply@<domain>`, and the sandbox runtime reads the same name,
  // so one unconditional producer here replaces the sandbox-only one.
  // Emitted after the user's vars in the upload array, so it also stops
  // being shadowable — see `reserved-bindings.ts`.
  bindings.push({ type: 'plain_text', name: '__VOID_PROJECT_SLUG', text: platform.projectSlug });
  if (platform.emailSenderDomain) {
    bindings.push({
      type: 'plain_text',
      name: '__VOID_EMAIL_DOMAIN',
      text: platform.emailSenderDomain,
    });
  }

  return bindings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureResource(
  db: Db,
  accountId: string,
  apiToken: string,
  projectId: string,
  type: Resource['type'],
  bindingName: string,
  existing: ReadonlyArray<Resource>,
): Promise<Resource> {
  // Normalize: R2 bucket names only allow lowercase alphanumeric + hyphens
  const resourceName = `${projectId}-${bindingName}`.toLowerCase().replaceAll('_', '-');

  const found = existing.find((r) => r.type === type && r.binding_name === bindingName);
  if (found) {
    // Fix legacy queue resources that stored queue_name instead of queue_id (UUID)
    if (type === 'queue' && !UUID_RE.test(found.cf_id)) {
      const queueInfo = await getQueueByName(accountId, apiToken, resourceName);
      await db
        .update(resourcesTable)
        .set({ cf_id: queueInfo.queue_id })
        .where(eq(resourcesTable.id, found.id));
      found.cf_id = queueInfo.queue_id;
    }
    return found;
  }
  let cfId: string;
  // Track whether WE created the CF object. Only a self-created object is safe to
  // roll back below — an already-exists lookup may be adopting a pre-existing
  // resource we don't own.
  let createdByUs = false;

  try {
    cfId = await createCfResource(type, accountId, apiToken, resourceName);
    createdByUs = true;
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      cfId = await lookupCfResource(type, accountId, apiToken, resourceName);
    } else {
      throw err;
    }
  }

  try {
    return await createResource(db, projectId, type, cfId, bindingName);
  } catch (err) {
    // The CF object exists but its `resources` row did not persist — most often a
    // FK violation because teardown deleted the project concurrently (the project
    // FOR UPDATE in deleteProjectCascade serializes against this INSERT's FK FOR
    // KEY SHARE). Without the row there is no durable handle, and teardown's
    // cascade-capture sweep can't see it, so it would orphan the CF object. Delete
    // what we just created before rethrowing. Best-effort: a failure here only
    // falls back to the same orphan we're trying to avoid. (Pre-existing objects
    // adopted via the already-exists lookup are left alone — not ours to delete.)
    if (createdByUs) {
      await deleteCfResource(type, accountId, apiToken, cfId).catch(() => {});
    }
    throw err;
  }
}

/** Delete a CF resource by type — the rollback dual of {@link createCfResource}. */
function deleteCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  cfId: string,
): Promise<void> {
  switch (type) {
    case 'd1':
      return deleteD1Database(accountId, apiToken, cfId);
    case 'kv':
      return deleteKVNamespace(accountId, apiToken, cfId);
    case 'r2':
      return deleteR2Bucket(accountId, apiToken, cfId);
    case 'queue':
      return deleteQueue(accountId, apiToken, cfId);
    case 'hyperdrive':
    case 'container':
      // ensureResource never creates these (createCfResource throws first), so a
      // rollback can't reach here. Resolve so the type switch stays exhaustive.
      return Promise.resolve();
  }
}

async function createCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await createD1Database(accountId, apiToken, resourceName);
      return result.uuid;
    }
    case 'kv': {
      const result = await createKVNamespace(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2': {
      const result = await createR2Bucket(accountId, apiToken, resourceName);
      return result.name;
    }
    case 'queue': {
      const result = await createQueue(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

async function lookupCfResource(
  type: Resource['type'],
  accountId: string,
  apiToken: string,
  resourceName: string,
): Promise<string> {
  switch (type) {
    case 'd1': {
      const result = await getD1DatabaseByName(accountId, apiToken, resourceName);
      return result.uuid;
    }
    case 'kv': {
      const result = await getKVNamespaceByTitle(accountId, apiToken, resourceName);
      return result.id;
    }
    case 'r2':
      // R2 bucket name IS the cf_id — no lookup API needed
      return resourceName;
    case 'queue': {
      const result = await getQueueByName(accountId, apiToken, resourceName);
      return result.queue_id;
    }
    case 'hyperdrive':
      throw new Error(
        'Hyperdrive resources are provisioned via the database endpoint, not ensureResource',
      );
    case 'container':
      throw new Error('Container resources are provisioned during sandbox deployment');
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message.toLowerCase();
  return msg.includes('already exists') || msg.includes('already been created');
}
