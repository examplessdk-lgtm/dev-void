import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfigEntryString as readD1EntryString } from '@void/deploy-cloudflare';
import { dirname, join, resolve } from 'pathslash';
import { analyzeApplicationSync, type ApplicationAnalysis } from '../application-analysis.ts';
import { type VoidConfig } from '../config.ts';
import {
  resolveSandboxConfig,
  sandboxContainerConfig,
  SANDBOX_MIGRATION_TAG,
  hasSandboxSqliteMigration,
} from '../sandbox/config.ts';
import { type BindingIdentitySnapshot } from './deploy-types.ts';
import { resolveCloudflareOperationArgv } from './preset.ts';
// Type-only: the provision module must load lazily (see `deploy-types.ts`).
import type { DesiredResourceSet, ProvisionDriftEntry } from './provision.ts';
import {
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  bindingEntriesForField,
  FRIENDLY_BINDING_NAMES,
  hasDurableObjectSqliteMigration,
  LIVE_MIGRATION_TAG,
  nextDurableObjectMigrationTag,
} from './wrangler.ts';

/** The id-bearing binding fields whose identity must survive the build unchanged. */
export const DEPLOY_BINDING_IDENTITY_FIELDS: Record<
  ProvisionDriftEntry['kind'],
  { field: string; idField: string }
> = {
  d1: { field: 'd1_databases', idField: 'database_id' },
  kv: { field: 'kv_namespaces', idField: 'id' },
  r2: { field: 'r2_buckets', idField: 'bucket_name' },
  hyperdrive: { field: 'hyperdrive', idField: 'id' },
};

/** Every id-bearing binding in the desired set, as `{ kind, binding }` pairs. */
export function desiredIdentityBindings(
  desired: DesiredResourceSet,
): Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> {
  const out: Array<{ kind: ProvisionDriftEntry['kind']; binding: string }> = [];
  if (desired.d1) {
    out.push({ kind: 'd1', binding: desired.d1.binding });
  }
  for (const kv of desired.kvNamespaces) {
    out.push({ kind: 'kv', binding: kv.binding });
  }
  if (desired.r2) {
    out.push({ kind: 'r2', binding: desired.r2.binding });
  }
  if (desired.hyperdrive) {
    out.push({ kind: 'hyperdrive', binding: desired.hyperdrive.binding });
  }
  return out;
}

/**
 * The snapshot/lookup key for one binding identity. `field` is one of a fixed set of wrangler
 * config sections (`d1_databases` / `kv_namespaces` / `r2_buckets` / `hyperdrive`) and `binding`
 * is a wrangler binding name (an identifier — no `:`), so the joined key is collision-free.
 */
export function bindingIdentityKey(field: string, binding: string): string {
  return `${field}:${binding}`;
}

/**
 * Enumerate EVERY id-bearing binding DECLARED in `config` across the four id-bearing sections
 * (`d1_databases` / `kv_namespaces` / `r2_buckets` / `hyperdrive`), as `{ field, binding, id }`.
 * `id` is `undefined` when the entry omits it or leaves it empty (never pinned, never asserted —
 * the same "absent or empty → undefined" collapse as {@link readStoredResourceName}). Reads each
 * entry on its OWN terms (never a first-match re-scan) so a duplicated / appended entry is seen as
 * itself. Section + id-field names come from {@link DEPLOY_BINDING_IDENTITY_FIELDS} — no per-kind
 * branching. Unlike {@link desiredIdentityBindings} this is NOT restricted to the desired set: it
 * captures a user's hand-declared extra binding too, which is exactly what lets the completeness
 * check tell a pre-existing binding apart from one the build injected.
 */
export function collectConfigBindingIdentities(
  config: Record<string, unknown>,
): Array<{ field: string; binding: string; id: string | undefined }> {
  const out: Array<{ field: string; binding: string; id: string | undefined }> = [];
  for (const { field, idField } of Object.values(DEPLOY_BINDING_IDENTITY_FIELDS)) {
    const list = config[field];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const binding = readD1EntryString(entry, 'binding');
      if (binding === undefined) {
        continue;
      }
      out.push({ field, binding, id: readD1EntryString(entry, idField) });
    }
  }
  return out;
}

/**
 * Snapshot the real, id-bearing identity of EVERY binding declared in the root `config` into an
 * in-memory map — the id defense's ground truth, mirroring the pinned in-memory `accountId`.
 *
 * Taken AFTER provision (which writes each real id into the root config via
 * `wrangler <res> create --update-config`) and the `name`/`account_id` reconcile, and BEFORE
 * the build. `vite build` runs untrusted project code with its Cloudflare credentials scrubbed,
 * so a compromised build dependency can only edit FILES — it could rewrite
 * `wrangler.jsonc`'s `d1_databases[<binding>].database_id` (keeping the binding + database_name)
 * to redirect the privileged remote D1 migrate or the deploy to a DIFFERENT same-account
 * resource, OR ADD a wholly new id-bearing binding (`EXTRA_DB`/`EXTRA_KV`/…) that the CF plugin
 * would then merge verbatim into `dist/ssr/wrangler.json`. Snapshotting EVERY declared id here —
 * not only the desired ones — and asserting the post-build config + emitted artifact carry
 * exactly this set closes both gaps for D1/KV/R2/Hyperdrive alike. A binding whose id is absent
 * post-drift (which the drift check already rejects for desired bindings) is simply not pinned —
 * never asserted.
 */
export function snapshotBindingIdentities(
  config: Record<string, unknown>,
): BindingIdentitySnapshot {
  const snapshot: BindingIdentitySnapshot = new Map();
  for (const { field, binding, id } of collectConfigBindingIdentities(config)) {
    if (id !== undefined) {
      snapshot.set(bindingIdentityKey(field, binding), id);
    }
  }
  return snapshot;
}

/**
 * Resource fields Void's OWN build legitimately emits into `dist/ssr/wrangler.json` — either
 * merged by `mergeBindings` (index.ts) or default-filled by the wrangler normalizer — so an entry
 * the artifact declares in one of THESE is NOT an injection and must not be asserted against the
 * pre-build root. Audited against `mergeBindings` (index.ts) + 13 real playground
 * `dist/ssr/wrangler.json` artifacts: the only {@link FRIENDLY_BINDING_NAMES} fields ever emitted
 * non-empty are these. The four id-bearing fields are excluded here because the id-pin
 * ({@link DEPLOY_BINDING_IDENTITY_FIELDS}) already pins them precisely.
 */
export const DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS: ReadonlySet<string> = new Set<string>([
  // id-pinned elsewhere (DEPLOY_BINDING_IDENTITY_FIELDS)
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'hyperdrive',
  // Void-emitted / merged by mergeBindings
  'ai',
  'durable_objects',
  'assets',
  'vars',
  // bundled content / worker self-metadata — no external-resource grant, and worker code is
  // already fully controlled by a malicious build, so pinning these adds nothing
  'data_blobs',
  'text_blobs',
  'wasm_modules',
  'version_metadata',
]);

/**
 * The pass-through assert-set: every binding field wrangler knows about
 * ({@link FRIENDLY_BINDING_NAMES}, Void's authoritative transcription of wrangler's binding
 * registry) that Void does NOT itself emit. An entry the EMITTED artifact declares in one of
 * these is either a verbatim pass-through of the user's OWN root config (captured in the pre-build
 * snapshot) or a build-time INJECTION — the latter would grant the deployed worker a same-account
 * capability the source never asked for (a `services` binding to another worker, a
 * `secrets_store_secrets` handle, a `dispatch_namespaces` entry, an `unsafe` binding of an
 * arbitrary type, …), which the CF plugin passes through into the emitted config and the
 * credentialed `wrangler deploy` then binds.
 *
 * Complete-by-construction against the known registry: it auto-covers every capability field
 * (browser/images/stream/media/websearch/unsafe included) and any FUTURE field added to the
 * registry fails CLOSED — a new registry field is asserted until explicitly excluded here. Fields
 * wrangler does not yet know about are absent from the registry and still fail OPEN — the same
 * residual the id-pin has, so a future resource field can never false-positive a legitimate build.
 */
export const DEPLOY_PASSTHROUGH_ASSERT_FIELDS: ReadonlyArray<string> = Object.keys(
  FRIENDLY_BINDING_NAMES,
).filter((field) => !DEPLOY_PASSTHROUGH_EXCLUDE_FIELDS.has(field));

/**
 * Fields the CF plugin passes through VERBATIM that the per-binding ENTRY pin cannot cover, so
 * each is compared WHOLE against the raw pre-build root value instead:
 *   - `unsafe` — is in {@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS} (so it stays in the drift
 *     invariant) but its `.metadata`/`.capnp` are never entry-iterated, and wrangler applies
 *     `unsafe.metadata` LAST at upload, OVERWRITING the whole uploaded bindings array — so an
 *     entry-level pin is blind to it. Routed OUT of the entry loop into the whole-object pin.
 *   - `tail_consumers` / `streaming_tail_consumers` — are NOT "bindings" (absent from
 *     {@link FRIENDLY_BINDING_NAMES}), so the assert-set structurally can't see them, yet wrangler
 *     uploads them and they forward every log/request to the named worker (exfil).
 *   - `routes` / `route` / `workers_dev` / `preview_urls` — the worker's TRAFFIC attachment. A
 *     build that injects a `routes`/`route` entry attaches the deployed worker to a production
 *     hostname/path the account controls (traffic interception), and flipping `workers_dev` /
 *     `preview_urls` changes its public exposure. None is a "binding" either, so the assert-set
 *     can't see them, yet wrangler uploads them.
 *   - `addresses` — the worker's INBOUND MAIL attachment (0078 Mode B). wrangler ≥ 4.113
 *     reconciles the account's Email Routing rules from this array on `wrangler deploy`: a build
 *     that injects an address redirects the account's inbound mail to the deployed worker, and one
 *     that drops the root's removes the rules Void's email step set up. Not a binding either, and
 *     the CF plugin passes the key through verbatim.
 * Void's own build emits NONE of them: a clean `vite build` (root declaring none) leaves every one
 * ABSENT from the emitted artifact (verified against a real build), so an emptiness check
 * ({@link isEmptyPassthroughValue}) keeps the normalizer's default-fill from false-positiving.
 */
export const DEPLOY_WHOLE_OBJECT_PINNED_FIELDS: ReadonlyArray<string> = [
  'unsafe',
  'tail_consumers',
  'streaming_tail_consumers',
  'routes',
  'route',
  'workers_dev',
  'preview_urls',
  'addresses',
];

/**
 * Fields whose RAW pre-build root value {@link snapshotPassthroughRawFields} captures for
 * {@link verifyGeneratedDeployConfig}'s whole-object + targeted checks: the
 * {@link DEPLOY_WHOLE_OBJECT_PINNED_FIELDS} plus `durable_objects` (external-DO check), `ai`
 * (binding pin), and `migrations` (destructive-DO-migration check). The last three are Void-emitted
 * (excluded from the assert-set) yet still need a pin because a build can add an EXTERNAL DO handle
 * (`script_name`), a rewritten/removed `ai` binding, or a DESTRUCTIVE Durable Object migration.
 */
const DEPLOY_RAW_SNAPSHOT_FIELDS: ReadonlyArray<string> = [
  ...DEPLOY_WHOLE_OBJECT_PINNED_FIELDS,
  'durable_objects',
  'ai',
  'migrations',
];

/** Void's default injected Workers AI binding name (`mergeBindings` in index.ts). */
export const DEFAULT_VOID_AI_BINDING = 'AI';

/**
 * Sub-fields on a `durable_objects` binding that make it target ANOTHER worker's Durable Objects.
 * `script_name` is the one wrangler binds a cross-script DO through; `environment` narrows a
 * cross-script binding to a named environment — either marks a binding Void's own build never
 * emits (its DOs are always LOCAL `{name, class_name}`).
 */
const DURABLE_OBJECT_EXTERNAL_FIELDS = ['script_name', 'environment'];

/**
 * Keys on a wrangler `migrations` entry that DELETE or MOVE existing Durable Object classes (and
 * their stored data): `deleted_classes` drops them, `renamed_classes` renames them, and the two
 * `transferred_classes*` keys move them from another script. Void's own emitted migrations only
 * ever carry the CREATION keys (`new_classes` / `new_sqlite_classes`), never one of these — so an
 * emitted entry carrying one is a build injection that `wrangler deploy` would run against
 * production Durable Object data.
 */
const DESTRUCTIVE_MIGRATION_KEYS = [
  'deleted_classes',
  'renamed_classes',
  'transferred_classes',
  'transferred_classes_from_script',
];

/**
 * A pin of every pass-through binding's ENTRY per {@link DEPLOY_PASSTHROUGH_ASSERT_FIELDS} field —
 * field → (bindingName → the root entry object) — captured from the root config at the SAME
 * pre-build point as {@link snapshotBindingIdentities} (after provision/drift resolves ids, before
 * the untrusted build). Lets a user's LEGITIMATELY hand-declared pass-through binding (e.g. a
 * `services` entry present before the build) survive, while an entry the build ADDED — absent from
 * this pin — OR one whose TARGET the build rewrote (same name, different service/namespace/type)
 * fails closed at {@link verifyGeneratedDeployConfig}. Entries come from each field's wrangler
 * shape via {@link bindingEntriesForField} (the SAME shapes the build's uniqueness check uses), so
 * `send_email` / `ratelimits` key on `.name` and `logfwdr` on its nested `.bindings[].name`. A
 * present field whose shape the strict reader cannot parse is recorded as an EMPTY inner map, so
 * any emitted entry in it fails closed on the symmetric read.
 */
export function snapshotPassthroughIdentities(
  config: Record<string, unknown>,
): Map<string, Map<string, Record<string, unknown>>> {
  const snapshot = new Map<string, Map<string, Record<string, unknown>>>();
  for (const field of DEPLOY_PASSTHROUGH_ASSERT_FIELDS) {
    if (config[field] === undefined) {
      continue;
    }
    const entries = new Map<string, Record<string, unknown>>();
    try {
      for (const { name, entry } of bindingEntriesForField(field, config[field])) {
        entries.set(name, entry);
      }
    } catch {
      // A malformed field records an EMPTY pin, so any emitted entry in it fails closed below.
      entries.clear();
    }
    snapshot.set(field, entries);
  }
  return snapshot;
}

/**
 * Companion of {@link snapshotPassthroughIdentities} for the fields the per-binding ENTRY pin
 * cannot cover: capture the RAW pre-build root value for each {@link DEPLOY_RAW_SNAPSHOT_FIELDS}
 * entry. Taken at the SAME pre-build point
 * as the other snapshots, so a build that INJECTS or REWRITES one of these into the emitted
 * artifact is caught at {@link verifyGeneratedDeployConfig}, while a user's own hand-declared value
 * (present here, unchanged) passes.
 */
export function snapshotPassthroughRawFields(
  config: Record<string, unknown>,
): Map<string, unknown> {
  const snapshot = new Map<string, unknown>();
  for (const field of DEPLOY_RAW_SNAPSHOT_FIELDS) {
    snapshot.set(field, config[field]);
  }
  return snapshot;
}

/**
 * Reconstruct the exact `containers` set Void's build emits into `dist/ssr/wrangler.json`, computed
 * PRE-BUILD from the SAME inputs `mergeBindings` (index.ts) uses so a legitimate build's emitted
 * entry deepEquals one reconstructed here:
 *   1. every root-declared container passes through VERBATIM (mergeBindings spreads
 *      `resolved.containers` unchanged), and
 *   2. PLUS — only when the source needs the sandbox (`needsSandbox`, the SAME
 *      `isSandboxEnabled(config) || inferProjectBindings(...).needsSandbox` signal index.ts gates
 *      emission on) AND no root-declared container already declares the sandbox class — the single
 *      Void sandbox container, built field-for-field from {@link resolveSandboxConfig} (the SAME
 *      pure function the build calls, so the reconstructed entry is byte-identical to the emitted
 *      one, absent optionals omitted).
 * A bare `wrangler deploy` PROVISIONS a container application from this array (billable, and it runs
 * the image's code), so pinning it lets {@link verifyGeneratedDeployConfig} reject a container the
 * build injected, dropped, or retargeted.
 */
export function reconstructExpectedContainers(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  needsSandbox: boolean,
): Array<Record<string, unknown>> {
  const rootContainers: Array<Record<string, unknown>> = Array.isArray(rootConfig.containers)
    ? (rootConfig.containers as Array<Record<string, unknown>>)
    : [];
  const expected: Array<Record<string, unknown>> = [...rootContainers];
  if (needsSandbox) {
    const sandbox = resolveSandboxConfig(config, root);
    const index = expected.findIndex(
      (container) => readD1EntryString(container, 'class_name') === sandbox.className,
    );
    if (index >= 0) {
      expected.splice(index, 1);
    }
    expected.push(sandboxContainerConfig(sandbox));
  }
  return expected;
}

/** Normalize only the named-image path fields Vite relocates into its output config. */
export function normalizeContainerImagePaths(container: unknown, base: string): unknown {
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    return container;
  }
  const value = container as Record<string, unknown>;
  if (!value.images || typeof value.images !== 'object' || Array.isArray(value.images)) {
    return container;
  }
  return {
    ...value,
    images: Object.fromEntries(
      Object.entries(value.images).map(([name, source]) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          return [name, source];
        }
        const image = { ...source } as Record<string, unknown>;
        for (const key of ['dockerfile', 'build_context']) {
          if (typeof image[key] === 'string') {
            image[key] = resolve(base, image[key]);
          }
        }
        return [name, image];
      }),
    ),
  };
}

/** Reconstruct the Durable Object state emitted after the pre-build root config is synced. */
export function reconstructExpectedDurableObjectState(
  config: VoidConfig,
  root: string,
  rootConfig: Record<string, unknown>,
  options: { needsSandbox: boolean; needsLive: boolean; analysis?: ApplicationAnalysis },
): {
  bindings: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
} {
  // classifyCloudflareDeployApp syncs WebSocket and authored Durable Object
  // modules into the root config before this snapshot. The build starts with
  // that same config, then may append its sandbox and live bindings.
  const bindings = bindingEntriesForField('durable_objects', rootConfig.durable_objects).map(
    ({ entry }) => entry,
  );
  const migrations: Array<Record<string, unknown>> = Array.isArray(rootConfig.migrations)
    ? [...(rootConfig.migrations as Array<Record<string, unknown>>)]
    : [];
  const sandbox = options.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  if (sandbox) {
    if (!bindings.some((binding) => binding.name === sandbox.binding)) {
      bindings.push({ name: sandbox.binding, class_name: sandbox.className });
    }
    if (!hasSandboxSqliteMigration(migrations, sandbox.className)) {
      migrations.push({
        tag: SANDBOX_MIGRATION_TAG,
        new_sqlite_classes: [sandbox.className],
      });
    }
  }

  const analysis = options.analysis ?? analyzeApplicationSync(root, { config });
  const websocketRoutes = analysis.allWebsockets;
  const durableObjects = analysis.durableObjects;
  const live = options.needsLive
    ? resolveLiveBindingConfig(root, {
        reservedBindings: [
          ...websocketRoutes.map((route) => route.bindingName),
          ...durableObjects.map((module) => module.bindingName),
        ],
        reservedClasses: [
          ...websocketRoutes.map((route) => route.className),
          ...durableObjects.map((module) => module.className),
          sandbox?.className,
        ],
      })
    : readExistingLiveBindingConfig(root);
  if (live) {
    if (!bindings.some((binding) => binding.name === live.bindingName)) {
      bindings.push({ name: live.bindingName, class_name: live.className });
    }
    if (!hasDurableObjectSqliteMigration(migrations, live.className)) {
      migrations.push({
        tag: nextDurableObjectMigrationTag(migrations, LIVE_MIGRATION_TAG),
        new_sqlite_classes: [live.className],
      });
    }
  }
  return { bindings, migrations };
}

/**
 * Deterministic sha256 over the wrangler uploader BUNDLE the credentialed deploy executes — the
 * resolved `wrangler-dist/cli.js` PLUS every sibling file in its directory. `cli.js` loads sibling
 * chunks from its own `__dirname` (the proxy workers, the experimental-config module), so the
 * whole directory is the trust surface, not just the entry file. Content hash of the bytes, NOT
 * mtime. Resolves the SAME entry {@link createDeployWranglerRunner} spawns (via
 * {@link resolveCloudflareOperationArgv}, whose launcher's LAST argv element is the JS entry). Returns
 * `undefined` when the entry cannot be resolved or a file cannot be read, so the caller FAILS
 * CLOSED — it never deploys a binary it could not verify. The resolver is injectable for tests.
 */
export function hashWranglerUploader(
  root: string,
  resolveArgv: (root: string) => Array<string> = resolveCloudflareOperationArgv,
): string | undefined {
  let entry: string | undefined;
  try {
    const argv = resolveArgv(root);
    entry = argv[argv.length - 1];
  } catch {
    return undefined;
  }
  if (typeof entry !== 'string' || entry.length === 0 || !existsSync(entry)) {
    return undefined;
  }
  return hashDirectoryContents(dirname(entry));
}

/** Pin the cf uploader and prebuilt-artifact builders before project code runs. */
export function hashCfUploader(): string | undefined {
  try {
    const hash = createHash('sha256');
    for (const name of ['cf', '@cloudflare/config', '@cloudflare/build-output-utils', 'vite']) {
      let path = dirname(fileURLToPath(import.meta.resolve(name)));
      while (!existsSync(join(path, 'package.json'))) {
        const parent = dirname(path);
        if (parent === path) {
          return undefined;
        }
        path = parent;
      }
      const contents = hashDirectoryContents(path);
      if (!contents) {
        return undefined;
      }
      hash.update(name);
      hash.update('\0');
      hash.update(contents);
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * sha256 over every file under `dir`, walked in a STABLE (name-sorted, depth-first) order with
 * each file's relative path folded into the digest, so the hash depends only on the directory's
 * contents — never on filesystem enumeration order. Returns `undefined` on any read error.
 */
function hashDirectoryContents(dir: string): string | undefined {
  try {
    const hash = createHash('sha256');
    const visiting = new Set<string>();
    const walk = (rel: string): void => {
      const real = realpathSync(join(dir, rel));
      if (visiting.has(real)) {
        throw new Error(`Cyclic symlink in uploader: ${rel}`);
      }
      visiting.add(real);
      try {
        const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const entry of entries) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childPath = join(dir, childRel);
          if (entry.isDirectory()) {
            walk(childRel);
            continue;
          }
          hash.update(childRel);
          hash.update('\0');
          if (entry.isSymbolicLink()) {
            hash.update(readlinkSync(childPath));
            hash.update('\0');
            try {
              const target = statSync(childPath);
              if (target.isDirectory()) {
                walk(childRel);
              } else if (target.isFile()) {
                hash.update(readFileSync(childPath));
              } else {
                throw new Error(`Unsupported uploader symlink target: ${childRel}`);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
              }
              hash.update('missing');
            }
          } else {
            hash.update(readFileSync(childPath));
          }
          hash.update('\0');
        }
      } finally {
        visiting.delete(real);
      }
    };
    walk('');
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Assert the wrangler uploader bundle was NOT modified between the pre-build snapshot and now.
 * A legitimate `vite build` never touches `node_modules/wrangler`, so the hash is stable across
 * the build. A build that overwrote the uploader — to run attacker code WITH the Cloudflare token
 * at the post-build remote migrate / deploy — changes it, and an unresolvable/unreadable binary
 * (either snapshot `undefined`) is a binary that cannot be verified: both FAIL CLOSED.
 */
export function assertWranglerUploaderUnchanged(
  before: string | undefined,
  after: string | undefined,
): { ok: boolean; reason?: string } {
  if (before === undefined || after === undefined) {
    return {
      ok: false,
      reason: `could not resolve or hash the Cloudflare uploader to verify it across the build — refusing to run a deploy binary that cannot be verified.`,
    };
  }
  if (before !== after) {
    return {
      ok: false,
      reason: `the build modified the Cloudflare uploader (its bundle hash changed across the build) — refusing to run it with your Cloudflare credentials.`,
    };
  }
  return { ok: true };
}

/**
 * True when a resource field's emitted value carries NO capability: `undefined`/`null`, an empty
 * array, an empty object, or a `{ bindings: [] }`. A clean `vite build` (root declaring none of
 * the whole-object-pinned fields) emits `unsafe` / `tail_consumers` / `streaming_tail_consumers`
 * ABSENT (verified against a real build); this also absorbs any normalizer default-fill
 * (`[]` / `{}` / `{ bindings: [] }`) so the whole-object pin never false-positives on an empty
 * shape while still catching a value that actually grants a capability.
 */
export function isEmptyPassthroughValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return true;
    }
    if (keys.length === 1 && keys[0] === 'bindings') {
      const bindings = (value as Record<string, unknown>).bindings;
      return Array.isArray(bindings) && bindings.length === 0;
    }
  }
  return false;
}

/**
 * Reject an emitted `durable_objects` binding that targets ANOTHER worker (carrying a
 * {@link DURABLE_OBJECT_EXTERNAL_FIELDS} sub-field) unless the pre-build root declared the SAME
 * binding byte-for-byte. Void's own build only ever emits LOCAL DO bindings (`{name, class_name}`;
 * index.ts), so an external DO in the artifact is a build injection — a handle to a same-account
 * worker's Durable Objects the source never asked for. Emitted LOCAL DOs (no cross-script field)
 * always pass. A malformed emitted `durable_objects` fails closed (Void never emits one).
 */
export function verifyNoInjectedExternalDurableObject(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  let emittedEntries: Array<{ name: string; entry: Record<string, unknown> }>;
  try {
    emittedEntries = bindingEntriesForField('durable_objects', emitted);
  } catch {
    return {
      ok: false,
      reason: `generated config declares a malformed durable_objects binding — refusing to deploy a binding set that cannot be verified.`,
    };
  }
  const rootByName = new Map<string, Record<string, unknown>>();
  try {
    for (const { name, entry } of bindingEntriesForField('durable_objects', root)) {
      rootByName.set(name, entry);
    }
  } catch {
    // A malformed root records no pins, so any emitted EXTERNAL DO fails closed below.
    rootByName.clear();
  }
  for (const { name, entry } of emittedEntries) {
    if (!DURABLE_OBJECT_EXTERNAL_FIELDS.some((key) => entry[key] !== undefined)) {
      continue;
    }
    const rootEntry = rootByName.get(name);
    if (rootEntry === undefined || !deepEqual(entry, rootEntry)) {
      return {
        ok: false,
        reason: `generated config declares a durable_objects binding ${JSON.stringify(name)} bound to another worker's script that was not present before the build — refusing to deploy an external Durable Object the build injected.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reject an emitted `migrations` entry that carries a {@link DESTRUCTIVE_MIGRATION_KEYS} key unless
 * the pre-build root declared the SAME entry byte-for-byte. Void's build only ever emits migrations
 * with CREATION keys (its own DOs), so a destructive entry in the artifact is a build injection —
 * `wrangler deploy` runs the emitted migrations and would DELETE or MOVE production Durable Object
 * data. Emitted entries with only creation keys are NEVER inspected (Void's own migrations pass
 * untouched), and a user's own root-declared destructive migration (e.g. a legit rename) is pinned
 * and passes. This is the destructive-injection guard only — deriving Void's complete desired
 * migration set (full array pinning) is out of scope.
 */
export function verifyNoInjectedDestructiveMigration(
  emitted: unknown,
  root: unknown,
): { ok: boolean; reason?: string } {
  if (!Array.isArray(emitted)) {
    // Void emits `migrations` as an array; a non-array (or absent) value carries no destructive
    // entry to check here, and full migration-array pinning is out of scope.
    return { ok: true };
  }
  const rootEntries = Array.isArray(root) ? root : [];
  for (const entry of emitted) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (!DESTRUCTIVE_MIGRATION_KEYS.some((key) => record[key] !== undefined)) {
      continue;
    }
    if (!rootEntries.some((rootEntry) => deepEqual(record, rootEntry))) {
      const tag = typeof record.tag === 'string' ? ` ${JSON.stringify(record.tag)}` : '';
      return {
        ok: false,
        reason: `generated config declares a destructive Durable Object migration${tag} (deleting, renaming, or transferring classes) that was not present before the build — refusing to deploy a migration the build added that would delete or move Durable Object data.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Minimal JSON-safe structural equality: primitives by `===`, arrays element-wise, plain objects
 * key-for-key (order-insensitive). Used to compare a pinned pre-build pass-through binding entry's
 * values against the emitted artifact's, so a build that RETARGETS a binding (rewrites a
 * service/namespace/type the user wrote in root) is caught while a normalizer-added default
 * sub-field is ignored. No cyclic/`undefined`/class support needed — wrangler config is JSON.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]),
  );
}

/**
 * Every queue NAME the emitted artifact binds — `queues.producers[].queue` +
 * `queues.consumers[].queue`. Non-throwing: a wrong-shaped `queues` field or an entry with no
 * readable `queue` string contributes no name (an unnamed queue binds nothing), so only real,
 * NAMED queue bindings are asserted against the desired set.
 */
export function collectEmittedQueueNames(value: unknown): Array<string> {
  const names: Array<string> = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return names;
  }
  for (const group of ['producers', 'consumers'] as const) {
    const list = (value as Record<string, unknown>)[group];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const name = readD1EntryString(entry, 'queue');
      if (name !== undefined) {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The queue NAMES the emitted artifact binds in ONE group (`producers` or `consumers`), as a Set.
 * Read defensively — a wrong-shaped `queues` field, a missing group, or an entry with no readable
 * `queue` string contributes no name — so a missing/empty group yields an EMPTY set. Used to assert
 * every DESIRED queue survives in BOTH groups: `mergeBindings` (index.ts) emits each desired queue as
 * both a producer AND a consumer, so per-group presence is required — {@link collectEmittedQueueNames}
 * merges the two groups and cannot tell that a queue lost one of its two sides.
 */
export function collectEmittedQueueGroupNames(
  value: unknown,
  group: 'producers' | 'consumers',
): Set<string> {
  const names = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return names;
  }
  const list = (value as Record<string, unknown>)[group];
  if (!Array.isArray(list)) {
    return names;
  }
  for (const entry of list) {
    const name = readD1EntryString(entry, 'queue');
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

/** The CF Vite plugin's deploy-config redirect that a bare `wrangler deploy` follows. */
export function deployPointerPath(root: string): string {
  return join(root, '.wrangler', 'deploy', 'config.json');
}
