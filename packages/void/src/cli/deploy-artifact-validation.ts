import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  parseRootWranglerConfig,
  readConfigEntryString as readD1EntryString,
  readStoredResourceName,
  assertExistingCloudflareConfig,
  type ExistingCloudflareWorker,
  type ApprovedCloudflareKvBinding,
} from '@void/deploy-cloudflare';
import { dirname, resolve } from 'pathslash';
import { type RoutingConfig } from '../config.ts';
import {
  deployPointerPath,
  desiredIdentityBindings,
  DEPLOY_BINDING_IDENTITY_FIELDS,
  bindingIdentityKey,
  collectConfigBindingIdentities,
  DEPLOY_PASSTHROUGH_ASSERT_FIELDS,
  DEPLOY_WHOLE_OBJECT_PINNED_FIELDS,
  deepEqual,
  isEmptyPassthroughValue,
  verifyNoInjectedExternalDurableObject,
  DEFAULT_VOID_AI_BINDING,
  verifyNoInjectedDestructiveMigration,
  normalizeContainerImagePaths,
  collectEmittedQueueNames,
  collectEmittedQueueGroupNames,
} from './deploy-binding-snapshot.ts';
import { log, getErrorMessage } from './deploy-helpers.ts';
import { BETTER_AUTH_SECRET_NAME } from './deploy-resources.ts';
import { buildSchemaProbeEnv } from './deploy-transport.ts';
import { type BindingIdentitySnapshot, type CloudflareDeployDeps } from './deploy-types.ts';
import type {
  EnvSchemaProbeInput,
  EnvSchemaProbeResult,
  EnvSchemaValidateResult,
} from './env-schema-probe.ts';
import {
  deriveSelfHostEnvContextFromVars,
  dischargeSelfHostEnvContext,
  readEmittedWorkerVars,
  selfHostSchemaFailureMessage,
  SelfHostEnvValidationError,
  SelfHostFirstDeployError,
  SelfHostSchemaError,
  SelfHostSecretListError,
  type EmittedWorkerVarsResult,
  type SelfHostSchemaFacts,
} from './env-validation.ts';
import { readGeneratedWranglerConfigFile } from './generated-wrangler-config.ts';
// Type-only: the provision module must load lazily (see `deploy-types.ts`).
import type { DesiredResourceSet } from './provision.ts';
import { bindingEntriesForField } from './wrangler.ts';

/**
 * Default {@link CloudflareDeployDeps.resolveSchemaFacts} seam: derive the
 * env-INSENSITIVE schema facts (server and required key names) in an ISOLATED SUBPROCESS ({@link
 * resolveEnvSchemaFactsViaSubprocess}) under the scrubbed `env`. The parent runs NO
 * project code: importing the user's env.ts (and resolving the Vite config) happens in
 * the child, so a deferred handler can never read the parent's credentials. Loaded
 * lazily so a managed deploy never pulls the probe in.
 */
export async function resolveEnvSchemaFactsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaProbeResult> {
  const { resolveEnvSchemaFactsViaSubprocess } = await import('./env-schema-probe.ts');
  return resolveEnvSchemaFactsViaSubprocess(input, env);
}

/**
 * Default {@link CloudflareDeployDeps.validateEmittedVars} seam: validate the REAL
 * emitted worker `vars` (post-build ground truth) against the schema validators in the
 * SAME isolated subprocess ({@link validateEmittedVarsViaSubprocess}) under the scrubbed
 * `env`, returning the FAILING key NAMES only. Runs the user's validators (project
 * code) off the credentialed parent; loaded lazily so a managed deploy never pulls it in.
 */
async function validateEmittedVarsDefault(
  input: EnvSchemaProbeInput,
  env: NodeJS.ProcessEnv,
): Promise<EnvSchemaValidateResult> {
  const { validateEmittedVarsViaSubprocess } = await import('./env-schema-probe.ts');
  return validateEmittedVarsViaSubprocess(input, env);
}

/**
 * Default {@link CloudflareDeployDeps.readEmittedWorkerVars} seam: read the REAL
 * `vars` map the build baked into `dist/ssr/wrangler.json` (ground truth — the exact
 * plaintext the worker ships). Delegates to the shared {@link readEmittedWorkerVars}
 * reader (also used by the isolated `validate-emitted` probe child), so the parent
 * and the child resolve the SAME artifact.
 */
function readEmittedWorkerVarsDefault(root: string): EmittedWorkerVarsResult {
  return readEmittedWorkerVars(root);
}

export function resolveGeneratedDeployConfigPathDefault(root: string): string {
  const pointerPath = deployPointerPath(root);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as { configPath?: unknown };
  if (typeof pointer.configPath !== 'string' || pointer.configPath.length === 0) {
    throw new Error(`Generated Cloudflare deploy pointer ${pointerPath} has no configPath.`);
  }
  return resolve(dirname(pointerPath), pointer.configPath);
}

export function readGeneratedDeployConfig(root: string): {
  path: string;
  config: Record<string, unknown>;
} {
  const redirectedPath = resolveGeneratedDeployConfigPathDefault(root);
  try {
    return { path: redirectedPath, config: readGeneratedWranglerConfigFile(redirectedPath) };
  } catch {
    throw new Error(
      `Generated Cloudflare deploy config ${redirectedPath} is missing or invalid JSON/JSONC.`,
    );
  }
}

/** Older project plugins can repeat root flags; normalize only the generated artifact. */
export function deduplicateGeneratedCompatibilityFlags(
  configPath: string,
  rootConfigPath: string,
): void {
  if (resolve(configPath) === resolve(rootConfigPath) || !existsSync(configPath)) {
    return;
  }
  const config = parseRootWranglerConfig(configPath);
  const flags = config.compatibility_flags;
  if (!Array.isArray(flags) || !flags.every((flag): flag is string => typeof flag === 'string')) {
    return;
  }
  const uniqueFlags = [...new Set(flags)];
  if (uniqueFlags.length !== flags.length) {
    config.compatibility_flags = uniqueFlags;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
}

/**
 * Check whether Void contributes worker-side routing rules.
 */
export function hasConfiguredVoidWorkerRoutingRules(routing: RoutingConfig | undefined): boolean {
  return (
    routing !== undefined &&
    [routing.redirects, routing.rewrites, routing.fallbacks, routing.headers].some(
      (rules) => rules !== undefined && Object.keys(rules).length > 0,
    )
  );
}

/**
 * Remove the CF plugin's deploy pointer before building so the post-build
 * verification can only pass on a pointer THIS build re-created. The CF plugin
 * overwrites (never deletes) it, and only when the CF Vite plugin runs — a build
 * that emits no worker artifact would otherwise leave a stale pointer from a prior
 * run, which a bare `wrangler deploy` would follow to old code.
 */
export function removeDeployPointer(root: string): void {
  rmSync(deployPointerPath(root), { force: true });
}

/**
 * Confirm the deploy config the CF Vite plugin emitted targets the pinned account, the
 * expected worker name, AND the exact resources this deploy provisioned — at the
 * TOP-LEVEL environment, BEFORE a bare `wrangler deploy` uploads anything.
 * `wrangler deploy` (no `-c`) follows `.wrangler/deploy/config.json` → the generated
 * `dist/.../wrangler.json`. A `CLOUDFLARE_ENV` / `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH`
 * in the ambient env or a production `.env` can make the build FLATTEN a named env or an
 * alternate config into that artifact — keeping the same `account_id`/`name` while
 * swapping the binding set, so `wrangler deploy --env=` ships it as top-level with no
 * mismatch. When a `bindingIdentitySnapshot` is given we therefore assert, in TWO directions,
 * that the generated artifact's id-bearing bindings (D1 database_id / KV id / R2 bucket_name /
 * Hyperdrive id) equal the identities PINNED before the build (the in-memory snapshot the
 * drift-check / provision resolved) — NOT a post-build re-read of the root config, so a build
 * that consistently rewrote BOTH the root config and this artifact is still caught:
 *   (a) with `desired`, every DESIRED binding must still be present with its pinned id — catches a
 *       binding the build DROPPED or whose id it rewrote; and
 *   (b) COMPLETENESS — every id-bearing binding the artifact declares must be one the snapshot
 *       pinned, with the pinned id — catches a binding the build ADDED (absent from the snapshot)
 *       or a pre-existing NON-desired binding whose id it rewrote, either of which the CF plugin
 *       would otherwise merge verbatim into the artifact and `wrangler deploy` would bind.
 * Only these four id-bearing kinds are inspected; every other binding the build legitimately
 * emits (ai / queues / durable_objects / vars / …) passes through untouched. This makes the id
 * defense symmetric with the `account_id` check above, which already compares against the
 * in-memory pinned account. Returns `{ ok:false, reason }` on any mismatch — or when the config
 * is missing/unreadable — so the caller fails closed.
 */
export function verifyGeneratedDeployConfig(
  root: string,
  expected: {
    accountId: string;
    workerName: string;
    desired?: DesiredResourceSet;
    bindingIdentitySnapshot?: BindingIdentitySnapshot;
    /**
     * Per-assert-field binding ENTRY pin taken pre-build ({@link snapshotPassthroughIdentities}) —
     * field → (bindingName → root entry). Drives the pass-through assertion: an emitted entry in a
     * field Void never emits whose binding was not pinned pre-build is a build-injected binding,
     * and one whose pinned target keys were rewritten is a build-retargeted binding.
     */
    passthroughIdentitySnapshot?: Map<string, Map<string, Record<string, unknown>>>;
    /**
     * Raw pre-build root values ({@link snapshotPassthroughRawFields}) for the fields the ENTRY
     * pin cannot cover: the whole-object-pinned fields, `durable_objects` (external-DO check),
     * `ai` (binding pin), and `migrations` (destructive-migration check). An emitted value that
     * diverges from its root pin — a whole-object field added/removed/rewritten, an external DO
     * absent from root, an `ai` binding that is neither the root's nor Void's own (and only when
     * the source uses AI), or an injected destructive migration — fails closed.
     */
    passthroughRawFields?: Map<string, unknown>;
    /**
     * Whether the pre-build inference found Workers AI use in the source (the SAME `needsAI`
     * signal `shouldBindWorkersAi` gates on in index.ts). Authorizes Void's emitted AI binding
     * (default `AI`, or `aiBindingName`) when the root config declares none: only an AI-using app
     * legitimately receives one, so a build that injects it into a non-AI app (billable inference
     * the source never asked for) fails closed.
     */
    needsAI?: boolean;
    /** Custom `inference.bindings.ai` name authorized for Void's emitted AI binding. */
    aiBindingName?: string;
    /**
     * Auth-enabled Cloudflare builds must emit `secrets.required` with
     * BETTER_AUTH_SECRET so Wrangler inherits the persistent remote value into
     * the uploaded Worker version instead of dropping it during replacement.
     */
    authEnabled?: boolean;
    /** Additional Worker secret names the generated version must inherit. */
    requiredSecretNames?: Array<string>;
    /**
     * The exact `containers` set Void's build emits, reconstructed PRE-BUILD
     * ({@link reconstructExpectedContainers}) from the root-declared containers plus — when the
     * source needs the sandbox — Void's own sandbox container. A bare `wrangler deploy` PROVISIONS a
     * container application from the emitted array (billable, runs the image), so an emitted
     * container absent from this set is one the build INJECTED, an expected container missing from
     * the emitted array is one it DROPPED, and one present but not byte-identical is one it
     * RETARGETED (e.g. a rewritten `image` pointing at an attacker's).
     */
    expectedContainers?: Array<Record<string, unknown>>;
    /** Exact pre-build Durable Object bindings, including Void's sandbox and live additions. */
    expectedDurableObjectBindings?: Array<Record<string, unknown>>;
    /** Exact pre-build migration sequence, including Void's sandbox and live additions. */
    expectedMigrations?: Array<Record<string, unknown>>;
    /**
     * The exact cron trigger schedules Void's build emits into `triggers.crons`, reconstructed
     * PRE-BUILD from the SAME `scanJobsSync` scan index.ts derives them from
     * ({@link computeDesiredCloudflareResources}). A bare `wrangler deploy` reading
     * `dist/ssr/wrangler.json` INSTALLS the worker's Cron Triggers from `triggers.crons`, so an
     * emitted schedule absent from this multiset is one the build INJECTED (attacker code runs on a
     * billable schedule) and an expected schedule missing from the emitted array is one it DROPPED
     * (or, paired with an injected replacement, RETARGETED).
     */
    expectedCrons?: Array<string>;
  },
): { ok: boolean; reason?: string } {
  const deployConfigPath = deployPointerPath(root);
  if (!existsSync(deployConfigPath)) {
    return {
      ok: false,
      reason: `expected the CF plugin's deploy config at ${deployConfigPath}, but it was not written by the build (a stale pointer is removed before building, so only a fresh one from this build is trusted).`,
    };
  }
  let redirectedPath: string;
  try {
    const parsed = JSON.parse(readFileSync(deployConfigPath, 'utf-8')) as { configPath?: unknown };
    if (typeof parsed.configPath !== 'string' || parsed.configPath.length === 0) {
      return { ok: false, reason: `${deployConfigPath} has no "configPath" pointer.` };
    }
    redirectedPath = resolve(dirname(deployConfigPath), parsed.configPath);
  } catch {
    return { ok: false, reason: `${deployConfigPath} is not valid JSON.` };
  }
  if (!existsSync(redirectedPath)) {
    return { ok: false, reason: `generated wrangler config ${redirectedPath} does not exist.` };
  }
  let generated: Record<string, unknown>;
  try {
    generated = readGeneratedWranglerConfigFile(redirectedPath);
  } catch {
    return {
      ok: false,
      reason: `generated wrangler config ${redirectedPath} is not valid JSON/JSONC.`,
    };
  }
  if (generated.account_id !== expected.accountId) {
    return {
      ok: false,
      reason: `generated config account_id ${JSON.stringify(generated.account_id)} does not match the pinned account ${JSON.stringify(expected.accountId)}.`,
    };
  }
  if (generated.name !== expected.workerName) {
    return {
      ok: false,
      reason: `generated config worker name ${JSON.stringify(generated.name)} does not match the expected worker ${JSON.stringify(expected.workerName)}.`,
    };
  }
  const expectedRequiredSecrets = new Set(expected.requiredSecretNames ?? []);
  if (expected.authEnabled) {
    expectedRequiredSecrets.add(BETTER_AUTH_SECRET_NAME);
  }
  if (expectedRequiredSecrets.size > 0) {
    const secrets = generated.secrets;
    const required =
      typeof secrets === 'object' && secrets !== null && !Array.isArray(secrets)
        ? (secrets as Record<string, unknown>).required
        : undefined;
    if (
      !Array.isArray(required) ||
      !required.every((name): name is string => typeof name === 'string') ||
      [...expectedRequiredSecrets].some((name) => !required.includes(name))
    ) {
      return {
        ok: false,
        reason:
          `generated config must include ${[...expectedRequiredSecrets].join(', ')} in ` +
          '`secrets.required` so wrangler inherits the persistent secrets during upload.',
      };
    }
  }
  // Binding-identity check: the generated artifact's id-bearing bindings must be the SAME ones
  // (by id) as were PINNED before the build (the in-memory snapshot). A flattened named-env /
  // alternate config — or a build that rewrote/added an id in BOTH the root config and this
  // artifact — keeps account+name but swaps the binding set, caught here against the snapshot.
  if (expected.bindingIdentitySnapshot) {
    const snapshot = expected.bindingIdentitySnapshot;
    // (a) Every DESIRED binding must still be present with its pinned id — catches a binding the
    // build DROPPED (the completeness loop below, which only walks what the artifact DECLARES,
    // cannot see an omission) or whose id it rewrote.
    if (expected.desired) {
      for (const { kind, binding } of desiredIdentityBindings(expected.desired)) {
        const { field, idField } = DEPLOY_BINDING_IDENTITY_FIELDS[kind];
        const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
        // A binding with no pinned id was never provisioned with a real one (the drift check's
        // job); here we only assert the generated artifact did not DIVERGE from the pre-build pin.
        if (pinnedId === undefined) {
          continue;
        }
        const generatedId = readStoredResourceName(generated, field, binding, idField);
        if (generatedId === undefined) {
          return {
            ok: false,
            reason: `generated config is missing the ${field} binding ${JSON.stringify(binding)} (pinned identity ${JSON.stringify(pinnedId)}) — a named environment or alternate config flattened a different binding set.`,
          };
        }
        if (generatedId !== pinnedId) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(generatedId)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a flattened/alternate or tampered binding set.`,
          };
        }
      }
    }
    // (b) COMPLETENESS — every id-bearing binding the artifact DECLARES must be one the snapshot
    // pinned (by binding name) AND carry the pinned id. The desired loop above only inspects the
    // desired set, so a binding the build ADDED to the root config (absent from the snapshot) or a
    // pre-existing NON-desired binding whose id it rewrote would otherwise flow into the artifact
    // and get bound by `wrangler deploy`. Scoped to the four id-bearing kinds only — every other
    // binding the build emits (ai / queues / durable_objects / vars / …) is neither inspected nor
    // rejected. The pin is the pre-build snapshot of the SAME root config the CF plugin merges, so
    // a legitimately emitted binding's id equals what was captured; only an added / rewritten one
    // diverges.
    const generatedIdentities = collectConfigBindingIdentities(generated);
    for (const { field, binding, id } of generatedIdentities) {
      const pinnedId = snapshot.get(bindingIdentityKey(field, binding));
      if (pinnedId === undefined) {
        return {
          ok: false,
          reason: `generated config declares a ${field} binding ${JSON.stringify(binding)} that was not present before the build — refusing to deploy an id-bearing binding the build injected.`,
        };
      }
      if (id !== pinnedId) {
        return {
          ok: false,
          reason: `generated config ${field} binding ${JSON.stringify(binding)} has identity ${JSON.stringify(id)} but the pinned pre-build identity is ${JSON.stringify(pinnedId)} — refusing to deploy a rewritten binding set.`,
        };
      }
    }
    // (c) Reverse-presence — the desired loop (a) inspects only the DESIRED bindings and the
    // completeness loop (b) walks only what the artifact DECLARES, so neither sees a NON-desired,
    // manually-declared root id-bearing binding (e.g. a hand-added `EXTRA_DB`) the build DROPPED: it
    // is absent from `desired`, and (b) cannot iterate an omission. Walk the PINNED snapshot instead —
    // every pinned `<field>:<binding>` must still appear among the emitted id-bearing bindings (read
    // the SAME way (b) reads them). A field the build removed entirely leaves every pinned binding in
    // it missing. This is the exact mirror of the pass-through reverse-presence loop (A1) below and is
    // FP-safe on the same reasoning: a legitimate CF-plugin build spreads the root config, so no
    // pinned id-binding is ever dropped; `bindingIdentitySnapshot` holds only bindings that had a real
    // id pre-build, so a placeholder/absent id is never asserted here.
    const emittedIdentityKeys = new Set<string>();
    for (const { field, binding } of generatedIdentities) {
      emittedIdentityKeys.add(bindingIdentityKey(field, binding));
    }
    for (const key of snapshot.keys()) {
      if (!emittedIdentityKeys.has(key)) {
        const separator = key.indexOf(':');
        const field = key.slice(0, separator);
        const binding = key.slice(separator + 1);
        return {
          ok: false,
          reason: `generated config no longer declares the ${field} binding ${JSON.stringify(binding)} that was present before the build — refusing to deploy a build that dropped an id-bearing binding the root config declared.`,
        };
      }
    }
  }
  // (A) Pass-through assert-set — every entry the artifact declares in a resource field Void's own
  // build never emits ({@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS}, derived from the wrangler binding
  // registry) must have been present in the pre-build root snapshot, matched by its wrangler-shape
  // identity key, AND be byte-identical to the pinned root entry. Two failures fail closed:
  //   • the binding name was NOT pinned pre-build → a binding the build INJECTED; and
  //   • the emitted entry differs from the pinned root entry → a binding the build REWROTE
  //     (kept the name but changed the service/namespace/type it points at, or added a sub-field).
  // Compare the WHOLE entry (exact equality): a real `vite build` adds NOTHING to a PRESENT
  // pass-through entry — services/vectorize/workflows/mtls_certificates/send_email/ratelimits/
  // dispatch_namespaces all emit byte-identical to root — so any added/removed/rewritten sub-field
  // is the build tampering with the binding's target. Fields NOT in the assert-set are deliberately
  // NOT asserted here (fail OPEN): a resource field wrangler does not yet know about must never
  // false-positive a legitimate build. `unsafe` stays in the assert-set (for the drift invariant)
  // but is routed to the whole-object pin below — its `.metadata`/`.capnp` are never entry-iterated.
  if (expected.passthroughIdentitySnapshot) {
    const passthrough = expected.passthroughIdentitySnapshot;
    for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || generated[field] === undefined) {
        continue;
      }
      let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
      try {
        emittedEntries = bindingEntriesForField(field, generated[field]);
      } catch {
        return {
          ok: false,
          reason: `generated config declares a malformed ${field} binding — refusing to deploy a binding set that cannot be verified.`,
        };
      }
      const pinned = passthrough.get(field) ?? new Map<string, Record<string, unknown>>();
      for (const { name, entry } of emittedEntries) {
        const pinnedEntry = pinned.get(name);
        if (pinnedEntry === undefined) {
          return {
            ok: false,
            reason: `generated config declares a ${field} binding ${JSON.stringify(name)} that was not present before the build — refusing to deploy a ${field} binding the build injected.`,
          };
        }
        if (!deepEqual(entry, pinnedEntry)) {
          return {
            ok: false,
            reason: `generated config ${field} binding ${JSON.stringify(name)} differs from the pre-build config — refusing to deploy a ${field} binding the build rewrote.`,
          };
        }
      }
    }
    // (A1) Reverse-presence — the forward loop above only walks EMITTED entries, so it cannot see a
    // root-declared pass-through binding the build DROPPED (removing a `services` / `mtls_certificates`
    // / … binding the source declared silently strips a capability). Walk the PINNED entries instead:
    // every pinned binding NAME must still appear in the emitted entries for its field. A field
    // ABSENT from the emitted config means every pinned name in it is missing. Whole-object-pinned
    // fields are skipped — their SYMMETRIC raw pin already rejects a removed value. FP-safe: a
    // legitimate CF-plugin build spreads the root config, so no pinned pass-through binding is ever
    // dropped; only a build that omits one to strip what the source declared is caught here.
    for (const [field, pinnedEntries] of passthrough) {
      if (DEPLOY_WHOLE_OBJECT_PINNED_FIELDS.includes(field) || pinnedEntries.size === 0) {
        continue;
      }
      const emittedNames = new Set<string>();
      if (generated[field] !== undefined) {
        try {
          for (const { name } of bindingEntriesForField(field, generated[field])) {
            emittedNames.add(name);
          }
        } catch {
          // A malformed emitted field is already rejected by the forward loop; treat it as carrying
          // no names so any pinned name is reported missing here too (fail closed).
        }
      }
      for (const name of pinnedEntries.keys()) {
        if (!emittedNames.has(name)) {
          return {
            ok: false,
            reason: `generated config no longer declares the ${field} binding ${JSON.stringify(name)} that was present before the build — refusing to deploy a build that dropped a ${field} binding the source declared.`,
          };
        }
      }
    }
  }
  // (A2) Whole-object + targeted pins for the fields the per-binding ENTRY pin cannot cover, each
  // compared against the raw pre-build root value ({@link snapshotPassthroughRawFields}):
  //   • `unsafe` / `tail_consumers` / `streaming_tail_consumers` — the emitted value must be
  //     byte-identical to the root's. The empty check is SYMMETRIC: an emitted empty value passes
  //     ONLY when the root value is ALSO empty (the clean-build shape / a normalizer default-fill).
  //     A root that DECLARED a non-empty value emitted back EMPTY is a REMOVAL — clearing
  //     `tail_consumers` silently disables the source's audit/log forwarding — so it is rejected
  //     like any other rewrite. `unsafe.metadata` overwrites the WHOLE uploaded bindings array at
  //     upload, and `tail_consumers`/`streaming_tail_consumers` forward every log/request — so a
  //     build injecting, rewriting, OR removing one changes exfil/audit the source declared.
  //   • `routes` / `route` / `workers_dev` / `preview_urls` — the worker's traffic attachment.
  //     Void emits none, so undeclared → absent → both-empty → pass; a build-injected `routes`
  //     entry (attaching the worker to a hostname the account controls) or a flipped
  //     `workers_dev`/`preview_urls` fails the deepEqual against the absent/declared root value.
  //   • `addresses` — the worker's inbound-mail attachment. Same pin, minus the both-empty pass:
  //     `[]` is loaded (it deletes every owned routing rule), so an emitted `[]` passes only
  //     when the root declared exactly `[]`.
  //   • `durable_objects` — an emitted binding carrying a cross-script field targets ANOTHER
  //     worker's DOs; Void's own DOs are always LOCAL, so it must match a root binding.
  //   • `ai` — when the root declared its own ai binding it must SURVIVE byte-identical (a build
  //     that REMOVED or rewrote it is rejected); otherwise the emitted binding must be ABSENT or —
  //     ONLY when the source's pre-build inference says the app uses Workers AI — Void's
  //     configured Workers AI binding. An injected AI binding on an app that does not use AI would
  //     incur account-billed inference from build-injected worker code.
  //   • `migrations` — an emitted Durable Object migration carrying a DESTRUCTIVE key (deleting,
  //     renaming, or transferring classes) must match a root-declared migration byte-for-byte;
  //     Void emits only creation-key migrations, so a destructive one is a build injection that
  //     `wrangler deploy` would run against production Durable Object data.
  if (expected.passthroughRawFields) {
    const raw = expected.passthroughRawFields;
    for (const field of DEPLOY_WHOLE_OBJECT_PINNED_FIELDS) {
      const emitted = generated[field];
      const rootValue = raw.get(field);
      // Both-empty is the only case an empty emitted value passes: a root that declared a
      // non-empty value emitted back empty REMOVES a control the source configured.
      // `addresses: []` is NOT empty to wrangler — it plans the deletion of every rule this
      // worker owns (wrangler returns early only on `undefined`, and never default-fills the
      // key) — so it gets no both-empty pass: an emitted `[]` must equal a root-declared `[]`.
      if (
        field !== 'addresses' &&
        isEmptyPassthroughValue(emitted) &&
        isEmptyPassthroughValue(rootValue)
      ) {
        continue;
      }
      if (!deepEqual(emitted, rootValue)) {
        return {
          ok: false,
          reason: `generated config ${field} value does not match the pre-build config — refusing to deploy a ${field} value the build added, removed, or rewrote.`,
        };
      }
    }
    const externalDo = verifyNoInjectedExternalDurableObject(
      generated.durable_objects,
      raw.get('durable_objects'),
    );
    if (!externalDo.ok) {
      return externalDo;
    }
    // Read `rootAi` FIRST (not gated on `emittedAi !== undefined`) so a root ai binding the build
    // REMOVED — emitted ai absent — is rejected too, not only a rewrite.
    const emittedAi = generated.ai;
    const rootAi = raw.get('ai');
    if (rootAi !== undefined) {
      // The root declared its own `ai` binding — the emitted one must equal it EXACTLY, so a build
      // can neither rewrite a custom root ai binding down to the default `{binding:'AI'}` nor drop
      // it (`deepEqual(undefined, rootAi)` is false → a removed root ai fails closed here).
      if (!deepEqual(emittedAi, rootAi)) {
        return {
          ok: false,
          reason: `generated config ai binding does not match the pre-build root ai binding — refusing to deploy an ai binding the build removed or rewrote.`,
        };
      }
    } else if (emittedAi !== undefined) {
      // No root ai binding: Void emits the configured binding name (default `AI`) ONLY when
      // pre-build inference says the source uses Workers AI. Anything else is build-injected.
      const expectedAi = { binding: expected.aiBindingName ?? DEFAULT_VOID_AI_BINDING };
      if (!(expected.needsAI === true && deepEqual(emittedAi, expectedAi))) {
        return {
          ok: false,
          reason: `generated config declares an ai binding the build injected — the pre-build inference found no Workers AI use in the source and the root config declares no ai binding.`,
        };
      }
    }
    // Reject a build-injected DESTRUCTIVE Durable Object migration. Only emitted migration entries
    // carrying a destructive key are checked, and each must match a root-declared migration
    // byte-for-byte, so Void's creation-only migrations and a user's own root-declared destructive
    // migration both pass — only an injected one absent from root is rejected.
    const destructiveMigration = verifyNoInjectedDestructiveMigration(
      generated.migrations,
      raw.get('migrations'),
    );
    if (!destructiveMigration.ok) {
      return destructiveMigration;
    }
  }
  if (expected.expectedDurableObjectBindings) {
    let emittedBindings: Array<Record<string, unknown>>;
    try {
      emittedBindings = bindingEntriesForField('durable_objects', generated.durable_objects).map(
        ({ entry }) => entry,
      );
    } catch {
      return {
        ok: false,
        reason: 'generated config durable_objects bindings could not be verified.',
      };
    }
    const byName = (left: Record<string, unknown>, right: Record<string, unknown>) =>
      String(left.name).localeCompare(String(right.name));
    if (
      !deepEqual(
        [...emittedBindings].sort(byName),
        [...expected.expectedDurableObjectBindings].sort(byName),
      )
    ) {
      return {
        ok: false,
        reason:
          'generated config durable_objects bindings differ from the pre-build binding set — refusing to deploy a binding the build added, removed, or retargeted.',
      };
    }
  }
  if (expected.expectedMigrations) {
    if (generated.migrations !== undefined && !Array.isArray(generated.migrations)) {
      return { ok: false, reason: 'generated config migrations could not be verified.' };
    }
    const emittedMigrations = Array.isArray(generated.migrations) ? generated.migrations : [];
    if (!deepEqual(emittedMigrations, expected.expectedMigrations)) {
      return {
        ok: false,
        reason:
          'generated config migrations differ from the pre-build migration sequence — refusing to deploy a migration the build added, removed, or retargeted.',
      };
    }
  }
  // (C) Containers — pin the emitted `containers` array against the set Void's build emits,
  // reconstructed PRE-BUILD ({@link reconstructExpectedContainers}): root-declared containers pass
  // through verbatim, plus Void's own sandbox container when the source needs it. A bare `wrangler
  // deploy` PROVISIONS a container application from this array — billable, and it runs the image's
  // code — so a build that INJECTS a container (an attacker image on an app that declared none),
  // DROPS the sandbox container, or RETARGETS one (rewrites its `image`/`instance_type`/… to an
  // attacker's) must fail closed. Compared as a set keyed by `class_name` — the identity
  // `mergeBindings` itself dedups on: every emitted container's class must be expected AND
  // byte-identical, and every expected class must still be emitted. `generated.containers` is read
  // defensively (absent/non-array → none), and absent-vs-`[]` is treated as both-empty so a clean
  // no-sandbox build (no root containers, Void adds none, emitted none) passes. Containers with no
  // `class_name` are not a shape Void or a buildable root config produce; they are compared as a
  // deepEqual multiset so a verbatim root passthrough still passes while an injected/dropped one
  // fails closed.
  if (expected.expectedContainers) {
    const emittedContainers: Array<unknown> = Array.isArray(generated.containers)
      ? generated.containers
      : [];
    const expectedContainers = expected.expectedContainers;
    if (emittedContainers.length !== 0 || expectedContainers.length !== 0) {
      const expectedByClass = new Map<string, Record<string, unknown>>();
      const expectedNoClass: Array<unknown> = [];
      for (const container of expectedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          expectedNoClass.push(container);
        } else {
          expectedByClass.set(className, container);
        }
      }
      const emittedByClass = new Map<string, unknown>();
      const emittedNoClass: Array<unknown> = [];
      for (const container of emittedContainers) {
        const className = readD1EntryString(container, 'class_name');
        if (className === undefined) {
          emittedNoClass.push(container);
        } else {
          emittedByClass.set(className, container);
        }
      }
      // Injected / retargeted — every emitted container must be expected AND byte-identical.
      for (const [className, container] of emittedByClass) {
        const expectedContainer = expectedByClass.get(className);
        if (expectedContainer === undefined) {
          return {
            ok: false,
            reason: `generated config declares a container application ${JSON.stringify(className)} that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        if (
          !deepEqual(
            normalizeContainerImagePaths(container, dirname(redirectedPath)),
            normalizeContainerImagePaths(expectedContainer, root),
          )
        ) {
          return {
            ok: false,
            reason: `generated config container application ${JSON.stringify(className)} does not match the pre-build config — refusing to deploy a container application the build retargeted.`,
          };
        }
      }
      // Dropped — every expected container must still be emitted.
      for (const className of expectedByClass.keys()) {
        if (!emittedByClass.has(className)) {
          return {
            ok: false,
            reason: `generated config no longer declares the container application ${JSON.stringify(className)} that Void derived from source — refusing to deploy a build that dropped a container application.`,
          };
        }
      }
      // Class-less containers — deepEqual multiset (never a Void-emitted shape).
      for (const emitted of emittedNoClass) {
        const matchIndex = expectedNoClass.findIndex((candidate) => deepEqual(emitted, candidate));
        if (matchIndex === -1) {
          return {
            ok: false,
            reason: `generated config declares a container application that Void did not derive from source — refusing to deploy a container application the build injected.`,
          };
        }
        expectedNoClass.splice(matchIndex, 1);
      }
      if (expectedNoClass.length > 0) {
        return {
          ok: false,
          reason: `generated config no longer declares a container application that was present before the build — refusing to deploy a build that dropped a container application.`,
        };
      }
    }
  }
  // (B) Queues ⊆ desired — every queue the artifact binds (producers/consumers) must be one Void
  // desired from source (`scanQueuesSync`, the SAME scan the build binds from), so a legitimate
  // build always satisfies emitted ⊆ desired. A queue NAME the artifact binds that is not in the
  // desired set is a queue binding the build injected — fail closed.
  if (expected.desired) {
    const desiredQueues = new Set(expected.desired.queues);
    for (const name of collectEmittedQueueNames(generated.queues)) {
      if (!desiredQueues.has(name)) {
        return {
          ok: false,
          reason: `generated config declares a queue binding ${JSON.stringify(name)} that Void did not derive from source — refusing to deploy a queue binding the build injected.`,
        };
      }
    }
    // (B1) desired ⊆ emitted, PER GROUP — the emitted ⊆ desired check above rejects an INJECTED
    // queue but waves through a DROPPED one: an absent/empty `queues` field, or one retaining only
    // the producer OR only the consumer, would deploy a worker that loses message processing or
    // leaves a `QUEUE_*` binding undefined. `mergeBindings` (index.ts) emits EVERY desired queue as
    // BOTH a producer and a consumer (both groups mapped from the SAME scanned array), so requiring
    // each desired queue name in both emitted groups is FP-safe. Read each group defensively (a
    // missing/empty/wrong-shaped `queues` field yields empty sets → any desired queue is reported
    // missing → reject); per-group presence is why this cannot reuse the merged reader above.
    const emittedProducers = collectEmittedQueueGroupNames(generated.queues, 'producers');
    const emittedConsumers = collectEmittedQueueGroupNames(generated.queues, 'consumers');
    for (const name of expected.desired.queues) {
      if (!emittedProducers.has(name) || !emittedConsumers.has(name)) {
        return {
          ok: false,
          reason: `generated config no longer binds the queue ${JSON.stringify(name)} as both a producer and a consumer that Void derived from source — refusing to deploy a build that dropped a queue binding the source declared.`,
        };
      }
    }
  }
  // (D) Cron Triggers — pin the emitted `triggers.crons` schedules against the set Void's build
  // emits, reconstructed PRE-BUILD from the SAME `scanJobsSync` scan index.ts derives them from
  // (`scanJobsSync(root, paths.cronsDir).flatMap((job) => job.crons)`). A bare `wrangler deploy`
  // reading `dist/ssr/wrangler.json` INSTALLS the worker's Cron Triggers from this array — a
  // schedule the build INJECTED runs attacker code on a billable schedule, and one it DROPPED (or
  // RETARGETED, caught as a drop of the old string plus an injection of the new one) silently
  // changes the worker's scheduled behavior. Compared as an order-independent, count-aware multiset
  // of schedule strings. `generated.triggers` is read DEFENSIVELY: only an object with an array
  // `crons` yields emitted schedules — anything else (absent, a bare `{}` the CF plugin
  // materializes for a no-cron app, a non-array `crons`) yields none, so a no-cron app (expected
  // empty, emitted none) passes symmetric-empty. A non-string emitted element is never a shape Void
  // derives, so it fails the expected lookup and is rejected as injected.
  if (expected.expectedCrons) {
    const triggers = generated.triggers;
    const emittedCrons: Array<unknown> =
      typeof triggers === 'object' &&
      triggers !== null &&
      Array.isArray((triggers as Record<string, unknown>).crons)
        ? ((triggers as Record<string, unknown>).crons as Array<unknown>)
        : [];
    const expectedCronCounts = new Map<string, number>();
    for (const schedule of expected.expectedCrons) {
      expectedCronCounts.set(schedule, (expectedCronCounts.get(schedule) ?? 0) + 1);
    }
    // Injected / retargeted — every emitted schedule must be one the source derived, with a
    // remaining count; anything else is a schedule the build injected.
    for (const schedule of emittedCrons) {
      const remaining = typeof schedule === 'string' ? (expectedCronCounts.get(schedule) ?? 0) : 0;
      if (typeof schedule !== 'string' || remaining <= 0) {
        return {
          ok: false,
          reason: `generated config declares a cron trigger schedule ${JSON.stringify(schedule)} that Void did not derive from source — refusing to deploy a schedule the build injected.`,
        };
      }
      expectedCronCounts.set(schedule, remaining - 1);
    }
    // Dropped — every expected schedule must still be emitted; any leftover count is a schedule the
    // build dropped (e.g. the old side of a retarget).
    for (const [schedule, remaining] of expectedCronCounts) {
      if (remaining > 0) {
        return {
          ok: false,
          reason: `generated config no longer installs the cron trigger schedule ${JSON.stringify(schedule)} that Void derived from source — refusing to deploy a build that dropped a cron trigger.`,
        };
      }
    }
  }
  return { ok: true };
}

/** Check the built Worker against the pinned deployment target before upload. */
export function verifyCloudflareDeployArtifact(
  root: string,
  deps: CloudflareDeployDeps,
  options: Parameters<typeof verifyGeneratedDeployConfig>[1],
): boolean {
  // 10. Verify the generated deploy config targets the pinned account + expected worker
  // AND the exact provisioned binding IDENTITIES BEFORE uploading. A `CLOUDFLARE_ENV` /
  // `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` the CF plugin loaded could have baked a
  // different account/name — or the SAME account/name with a flattened, DIFFERENT binding
  // set — into dist/ssr/wrangler.json; passing `desired` + the step-6 snapshots lets the check
  // reject a divergent binding set, not only an account/name mismatch. The comparison is against
  // the in-memory `bindingIdentitySnapshot` (NOT a post-build root re-read), so a build that
  // consistently rewrote both the root config and this artifact is still caught. The
  // `passthroughIdentitySnapshot` extends the same defense to the resource fields Void never emits
  // (`services` / `secrets_store_secrets` / …): an entry the build injected into one of them — or a
  // queue not in `desired.queues` — fails closed here too, before the credentialed upload binds it.
  const verification = (deps.verifyDeployConfig ?? verifyGeneratedDeployConfig)(root, options);
  if (!verification.ok) {
    log.error(
      [
        'deploy: the generated deploy config does not match the pinned target — refusing to deploy.',
        verification.reason,
        'This typically means CLOUDFLARE_ENV / CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH (in the',
        'environment or a production `.env`) selected a different named environment or config',
        'at build time. This backend always deploys the canonical top-level config — remove',
        'them and rebuild.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return false;
  }

  return true;
}

/** Validate emitted Worker vars and required secrets against post-build ground truth. */
export async function validateCloudflarePostBuildEnv(
  root: string,
  configPath: string,
  accountId: string,
  apiBaseUrl: string,
  workerName: string,
  schemaFacts: SelfHostSchemaFacts,
  authEnabled: boolean,
  existingWorker: ExistingCloudflareWorker | null,
  approvedHandoffKv: Array<ApprovedCloudflareKvBinding>,
  deps: CloudflareDeployDeps,
  assertUploaderStillPinned: () => boolean,
): Promise<boolean> {
  // 8. Post-build GROUND-TRUTH gates — validate the REAL artifact the build emitted, not a
  // facsimile. Read the actual `vars` the build baked into `dist/ssr/wrangler.json`, then
  // WARN (plaintext secret-looking vars) + GATE (required secrets, incl. INVALID values) +
  // auth-schema check + local migration gates, all against that ground truth. The only
  // project code that runs does so in the isolated `validate-emitted` probe (8b).
  const emitted = (deps.readEmittedWorkerVars ?? readEmittedWorkerVarsDefault)(root);
  if (existingWorker) {
    const generated = readGeneratedDeployConfig(root);
    assertExistingCloudflareConfig(existingWorker, generated.config, true, approvedHandoffKv);
  }
  if (!emitted.ok) {
    log.error(
      [
        'deploy: could not read the worker vars the build emitted — refusing to validate secrets.',
        `  ${emitted.reason}`,
        'The build must emit dist/ssr/wrangler.json for this backend. Rerun the build, or deploy',
        'this app with `void deploy` (the managed platform).',
      ].join('\n'),
    );
    return false;
  }
  const emittedVars = emitted.vars;
  // Better Auth's signing secret must never be baked into the generated config.
  // Match the managed Void deploy contract: the deploy target owns this secret
  // and stores it through its encrypted secret API, not through plaintext vars.
  if (authEnabled && Object.prototype.hasOwnProperty.call(emittedVars, BETTER_AUTH_SECRET_NAME)) {
    log.error(
      [
        `deploy: ${BETTER_AUTH_SECRET_NAME} must be stored as a Cloudflare Worker secret, not a plaintext worker var.`,
        'Remove it from Worker vars and rerun. This deploy command preserves an',
        'existing remote value or creates a persistent one automatically when it is missing.',
      ].join('\n'),
    );
    return false;
  }

  const plaintextServerKeys = schemaFacts.serverKeys.filter((key) => key in emittedVars);
  if (plaintextServerKeys.length > 0) {
    log.error(
      [
        'deploy: server env keys cannot ship as plaintext Worker vars:',
        ...plaintextServerKeys.map((key) => `  • ${key}`),
        'Remove them from Worker vars and set them with `void secret put <NAME>`.',
      ].join('\n'),
    );
    return false;
  }

  // 8b. Required-secret gate — build the values-free context from the REAL emitted vars + the
  // env-insensitive required-key names (pure parent work, no project code): a required key
  // shipped EMPTY (`K=""`) SHADOWS a same-named remote secret → fail closed always; a required
  // key ABSENT from the emitted vars is discharged only by `wrangler secret list`.
  const envContext = deriveSelfHostEnvContextFromVars(emittedVars, schemaFacts);
  // Then VALUE-validate the REAL emitted vars against the schema's validators in the isolated
  // `validate-emitted` probe (project code, off this credentialed parent) and fold the FAILING
  // key NAMES into the context, so a required var shipped with a MALFORMED value (e.g. a
  // non-number `PORT`, a bad JSON object) fails closed HERE — before any remote mutation —
  // rather than only at worker boot. Values-free: only key names cross the process boundary.
  if (schemaFacts.hasSchema) {
    let validateResult: EnvSchemaValidateResult;
    try {
      validateResult = await (deps.validateEmittedVars ?? validateEmittedVarsDefault)(
        { root },
        buildSchemaProbeEnv(accountId, apiBaseUrl),
      );
    } catch (err) {
      log.error(
        `deploy: could not validate the emitted worker vars against the env schema — ${getErrorMessage(err)}`,
      );
      return false;
    }
    if (validateResult.kind === 'schema-error') {
      log.error(`deploy: ${selfHostSchemaFailureMessage(validateResult.reason)}`);
      return false;
    }
    envContext.invalidKeys = validateResult.invalidKeys;
  }
  // The auth secret has its own deploy-owned lifecycle below. If an env schema
  // also declares it required, do not make the generic secret gate reject it
  // before the deploy has a chance to provision and verify it.
  if (authEnabled) {
    envContext.absentRequired = envContext.absentRequired.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
    envContext.invalidKeys = envContext.invalidKeys.filter(
      (key) => key !== BETTER_AUTH_SECRET_NAME,
    );
  }
  // DISCHARGE the context. Reuses the same `dischargeSelfHostEnvContext` the unit tests
  // exercise, fed the ground-truth vars + the real invalid-value set. It may spawn a
  // credentialed `wrangler secret list` (its own runner, via `createDefaultSecretListRunner`),
  // which runs the hashed uploader bundle — and the emitted-var validation above just ran project
  // code (env.ts) that could have overwritten it. Re-verify the uploader against the pre-build
  // baseline immediately before the spawn.
  if (!assertUploaderStillPinned()) {
    return false;
  }
  try {
    await (deps.dischargeSelfHostEnv ?? dischargeSelfHostEnvContext)(envContext, {
      root,
      configPath,
      accountId,
      // Pin the worker NAME too: the secret list resolves the worker from the config's
      // `name`, which the emitted-var probe above (project code) could have rewritten
      // since step 5 pinned it. The gate reconciles the config against this and fails
      // closed on a mismatch, mirroring the account pin.
      workerName,
    });
  } catch (err) {
    if (
      err instanceof SelfHostFirstDeployError ||
      err instanceof SelfHostSecretListError ||
      err instanceof SelfHostEnvValidationError ||
      err instanceof SelfHostSchemaError
    ) {
      log.error(err.message);
      return false;
    }
    throw err;
  }

  return true;
}
