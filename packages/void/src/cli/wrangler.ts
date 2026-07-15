import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type FormattingOptions,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { join } from 'pathe';
import type { VoidConfig } from '../config.ts';
import type { InferredBindings } from '../inference/walk.ts';
import type { WebSocketRouteDefinition } from '../router/websocket.ts';
import {
  DEFAULT_SANDBOX_BINDING,
  SANDBOX_MIGRATION_TAG,
  resolveSandboxConfig,
  type ResolvedSandboxConfig,
} from '../sandbox/config.ts';

const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';
const NODEJS_ALS_FLAG = 'nodejs_als';
const NODEJS_COMPAT_FLAG = 'nodejs_compat';
const VOID_CONFIG_FILE = 'void.json';
export const DEFAULT_LIVE_BINDING = 'VOID_LIVE';
export const DEFAULT_LIVE_CLASS = 'VoidLiveStreamDurableObject';
export const LIVE_MIGRATION_TAG = 'live-v1';

export type LiveBindingConfig = {
  bindingName: string;
  className: string;
};

type DurableObjectMigration = {
  tag?: string;
  new_classes?: Array<string>;
  new_sqlite_classes?: Array<string>;
};

/** Latest compatibility date the Void test suite is pinned against. */
export const LATEST_KNOWN_COMPAT_DATE = '2026-02-24';

/** Subset of wrangler config fields we extract. */
export type WranglerCompat = {
  compatibilityDate: string;
  compatibilityFlags?: Array<string>;
};

type WranglerCompatFields = {
  voidConfig: VoidConfig | undefined;
  voidDate: string | undefined;
  voidFlags: Array<string> | undefined;
  wranglerDate: string | undefined;
  wranglerFlags: Array<string> | undefined;
  buildDate: string | undefined;
  buildFlags: Array<string> | undefined;
};

export function normalizeWranglerCompatibilityFlags(
  flags: Array<string> | undefined,
  options?: { needsNodejsCompat?: boolean },
): Array<string> | undefined {
  const existingFlags = flags ?? [];
  if (options?.needsNodejsCompat && !existingFlags.includes(NODEJS_COMPAT_FLAG)) {
    return [...existingFlags.filter((flag) => flag !== NODEJS_ALS_FLAG), NODEJS_COMPAT_FLAG];
  }
  if (
    existingFlags.length === 0 ||
    (!existingFlags.includes(NODEJS_ALS_FLAG) && !existingFlags.includes(NODEJS_COMPAT_FLAG))
  ) {
    return [...existingFlags, NODEJS_ALS_FLAG];
  }
  return flags;
}

export function hasDurableObjectSqliteMigration(
  migrations: Array<DurableObjectMigration>,
  className: string,
): boolean {
  return migrations.some((migration) => migration.new_sqlite_classes?.includes(className));
}

export function nextDurableObjectMigrationTag(
  migrations: Array<DurableObjectMigration>,
  baseTag: string,
): string {
  const existingTags = new Set(migrations.map((migration) => migration.tag).filter(Boolean));
  if (!existingTags.has(baseTag)) {
    return baseTag;
  }
  let index = 2;
  while (existingTags.has(`${baseTag}-${index}`)) {
    index++;
  }
  return `${baseTag}-${index}`;
}

export function resolveLiveBindingConfig(
  root: string,
  options?: {
    existingBindings?: Array<{ name: string; class_name: string }>;
    reservedBindings?: Array<string | undefined>;
    reservedClasses?: Array<string | undefined>;
  },
): LiveBindingConfig {
  const durableObjectBindings = [
    ...readWranglerDurableObjectBindings(root),
    ...(options?.existingBindings ?? []),
  ];

  const generated = findGeneratedLiveBinding(durableObjectBindings);
  if (generated) {
    return { bindingName: generated.name, className: generated.class_name };
  }

  const usedBindings = new Set<string>([
    ...durableObjectBindings.map((binding) => binding.name),
    ...(options?.reservedBindings ?? []).filter((name): name is string => typeof name === 'string'),
  ]);
  const usedClasses = new Set<string>([
    ...durableObjectBindings.map((binding) => binding.class_name),
    ...(options?.reservedClasses ?? []).filter((name): name is string => typeof name === 'string'),
  ]);

  return {
    bindingName: resolveGeneratedName(DEFAULT_LIVE_BINDING, usedBindings, 'binding'),
    className: resolveGeneratedName(DEFAULT_LIVE_CLASS, usedClasses, 'class'),
  };
}

export function readExistingLiveBindingConfig(root: string): LiveBindingConfig | undefined {
  const generated = findGeneratedLiveBinding(readWranglerDurableObjectBindings(root));
  return generated ? { bindingName: generated.name, className: generated.class_name } : undefined;
}

function readWranglerDurableObjectBindings(
  root: string,
): Array<{ name: string; class_name: string }> {
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    try {
      const parsed = parseJsonc(readFileSync(join(root, name), 'utf-8'));
      const bindings = (
        parsed.durable_objects as
          | { bindings?: Array<{ name?: unknown; class_name?: unknown }> }
          | undefined
      )?.bindings;
      if (!Array.isArray(bindings)) {
        return [];
      }
      return bindings.filter(
        (binding): binding is { name: string; class_name: string } =>
          typeof binding.name === 'string' && typeof binding.class_name === 'string',
      );
    } catch {
      // Try the next wrangler config filename.
    }
  }
  return [];
}

function isGeneratedLiveName(name: string, base: string): boolean {
  return name === base || name.match(generatedLiveNamePattern(base)) !== null;
}

function generatedLiveNamePattern(base: string): RegExp {
  return new RegExp(`^${escapeRegExp(base)}_[0-9a-f]{8}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findGeneratedLiveBinding(
  bindings: Array<{ name: string; class_name: string }>,
): { name: string; class_name: string } | undefined {
  return bindings.find(
    (binding) =>
      isGeneratedLiveName(binding.name, DEFAULT_LIVE_BINDING) &&
      isGeneratedLiveName(binding.class_name, DEFAULT_LIVE_CLASS),
  );
}

function resolveGeneratedName(base: string, used: Set<string>, kind: string): string {
  if (!used.has(base)) {
    return base;
  }

  for (let attempt = 0; ; attempt++) {
    const suffix = createHash('sha256')
      .update(`void/live:${kind}:${base}:${attempt}`)
      .digest('hex')
      .slice(0, 8);
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Read compatibility settings from `wrangler.jsonc`/`wrangler.json`,
 * `void.json`, and build output, with priority:
 * void.json > wrangler.jsonc > build output > latest known-good date.
 *
 * This function is read-only: when no explicit `compatibility_date` exists, it
 * returns the latest known-good date without writing it anywhere. Use
 * `ensureWranglerCompat()` when the caller is in a real dev/build/deploy
 * lifecycle and wants to persist the default in `void.json`.
 *
 * @param buildOutputDir - Optional path to the build output directory (e.g.
 *   `dist/ssr`) which may contain a plugin-generated `wrangler.json` with the
 *   correct compat settings for the built worker.
 */
export function readWranglerCompat(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
): WranglerCompat {
  return resolveWranglerCompat(readWranglerCompatFields(root, config, buildOutputDir));
}

/**
 * Read compatibility settings and ensure the default date is pinned in
 * `void.json` when no explicit date exists in void.json, wrangler config, or
 * build output.
 */
export function ensureWranglerCompat(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
): WranglerCompat {
  const fields = readWranglerCompatFields(root, config, buildOutputDir);
  const hasExplicitDate = fields.voidDate ?? fields.wranglerDate ?? fields.buildDate;
  const defaultDate = hasExplicitDate
    ? undefined
    : ensureVoidCompatibilityDate(root, fields.voidConfig);
  return resolveWranglerCompat(fields, defaultDate ? { defaultDate } : undefined);
}

function readWranglerCompatFields(
  root: string,
  config?: VoidConfig,
  buildOutputDir?: string,
): WranglerCompatFields {
  const voidConfig = config ?? readVoidConfigIfExists(root);

  // 1. Read wrangler.jsonc / wrangler.json from project root
  let raw: string | undefined;
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    try {
      raw = readFileSync(join(root, name), 'utf-8');
      break;
    } catch {
      // try next
    }
  }

  let wranglerDate: string | undefined;
  let wranglerFlags: Array<string> | undefined;
  if (raw) {
    const parsed = parseJsonc(raw);
    if (typeof parsed.compatibility_date === 'string') {
      validateCompatDate(parsed.compatibility_date, 'wrangler config');
      wranglerDate = parsed.compatibility_date;
    }
    if (
      Array.isArray(parsed.compatibility_flags) &&
      parsed.compatibility_flags.every((f: unknown) => typeof f === 'string')
    ) {
      wranglerFlags = parsed.compatibility_flags;
    }
  }

  // 1b. Read build output wrangler.json as fallback (generated by @cloudflare/vite-plugin)
  let buildDate: string | undefined;
  let buildFlags: Array<string> | undefined;
  if (buildOutputDir) {
    try {
      const buildRaw = readFileSync(join(buildOutputDir, 'wrangler.json'), 'utf-8');
      const buildParsed = JSON.parse(buildRaw);
      if (typeof buildParsed.compatibility_date === 'string') {
        validateCompatDate(buildParsed.compatibility_date, 'build output wrangler.json');
        buildDate = buildParsed.compatibility_date;
      }
      if (
        Array.isArray(buildParsed.compatibility_flags) &&
        buildParsed.compatibility_flags.every((f: unknown) => typeof f === 'string')
      ) {
        buildFlags = buildParsed.compatibility_flags;
      }
    } catch {
      // no build output wrangler.json
    }
  }

  // 2. Override with void.json worker fields (higher priority)
  const voidDate = voidConfig?.worker?.compatibility_date;
  const voidFlags = voidConfig?.worker?.compatibility_flags;
  if (voidDate !== undefined) {
    validateCompatDate(voidDate, 'void.json worker config');
  }

  return {
    voidConfig,
    voidDate,
    voidFlags,
    wranglerDate,
    wranglerFlags,
    buildDate,
    buildFlags,
  };
}

function resolveWranglerCompat(
  fields: WranglerCompatFields,
  options?: { defaultDate?: string },
): WranglerCompat {
  // 3. Merge: void.json > project wrangler.jsonc > build output
  const compatibilityDate =
    fields.voidDate ??
    fields.wranglerDate ??
    fields.buildDate ??
    options?.defaultDate ??
    LATEST_KNOWN_COMPAT_DATE;

  const result: WranglerCompat = {
    compatibilityDate,
  };

  const flags = fields.voidFlags ?? fields.wranglerFlags ?? fields.buildFlags;
  if (flags && flags.length > 0) {
    result.compatibilityFlags = flags;
  }

  return result;
}

function validateCompatDate(value: string, source: string): void {
  if (!COMPAT_DATE_RE.test(value)) {
    throw new Error(
      `config: "compatibility_date" in ${source} must use YYYY-MM-DD format, got '${value}'.`,
    );
  }
}

function readVoidConfigIfExists(root: string): VoidConfig | undefined {
  const filePath = join(root, VOID_CONFIG_FILE);
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`config: ${VOID_CONFIG_FILE} must be a JSON object.`);
    }
    return parsed as VoidConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`config: Invalid JSON in ${VOID_CONFIG_FILE}.`);
    }
    throw error;
  }
}

function ensureVoidCompatibilityDate(root: string, config?: VoidConfig): string {
  const filePath = join(root, VOID_CONFIG_FILE);
  let nextConfig: VoidConfig = {};

  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`config: ${VOID_CONFIG_FILE} must be a JSON object.`);
      }
      nextConfig = parsed as VoidConfig;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`config: Invalid JSON in ${VOID_CONFIG_FILE}.`);
      }
      throw error;
    }
  } else if (config) {
    nextConfig = { ...config };
  }

  nextConfig.worker = {
    ...(nextConfig.worker ?? {}),
    compatibility_date: LATEST_KNOWN_COMPAT_DATE,
  };
  writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return LATEST_KNOWN_COMPAT_DATE;
}

/**
 * Sync inferred/configured bindings into the project's wrangler.jsonc for local dev.
 * Only adds bindings that are missing — existing bindings are preserved.
 * Returns true if the file was modified.
 */
export function syncWranglerBindings(
  root: string,
  bindings: InferredBindings,
  options?: {
    bindingNames?: { d1?: string; kv?: string; r2?: string; sandbox?: string };
    websockets?: Array<WebSocketRouteDefinition>;
    sandbox?: ResolvedSandboxConfig;
    live?: boolean | LiveBindingConfig;
  },
): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  let created = false;
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        parsed = parseJsonc(readFileSync(p, 'utf-8'));
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, 'wrangler.jsonc');
    parsed = {};
    created = true;
  }

  let modified = false;

  // D1
  const d1Name = options?.bindingNames?.d1 ?? 'DB';
  if (bindings.needsD1) {
    const existing = (parsed.d1_databases as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === d1Name)) {
      parsed.d1_databases = [
        ...existing,
        { binding: d1Name, database_name: 'default', database_id: 'local' },
      ];
      modified = true;
    }
  }

  // KV
  const kvName = options?.bindingNames?.kv ?? 'KV';
  if (bindings.needsKV) {
    const existing = (parsed.kv_namespaces as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === kvName)) {
      parsed.kv_namespaces = [...existing, { binding: kvName, id: 'local' }];
      modified = true;
    }
  }

  // R2
  const r2Name = options?.bindingNames?.r2 ?? 'STORAGE';
  if (bindings.needsR2) {
    const existing = (parsed.r2_buckets as Array<{ binding: string }> | undefined) ?? [];
    if (!existing.some((b) => b.binding === r2Name)) {
      parsed.r2_buckets = [...existing, { binding: r2Name, bucket_name: 'default' }];
      modified = true;
    }
  }

  if (options?.websockets && options.websockets.length > 0) {
    const existing =
      ((
        parsed.durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined
      )?.bindings as Array<{ name: string; class_name: string }> | undefined) ?? [];
    const additions = options.websockets
      .filter((route) => !existing.some((binding) => binding.name === route.bindingName))
      .map((route) => ({ name: route.bindingName, class_name: route.className }));
    if (additions.length > 0) {
      parsed.durable_objects = { bindings: [...existing, ...additions] };
      modified = true;
    }

    if (!Array.isArray(parsed.migrations)) {
      parsed.migrations = [
        {
          tag: 'void-ws-v1',
          new_classes: options.websockets.map((route) => route.className),
        },
      ];
      modified = true;
    }
  }

  if (bindings.needsSandbox) {
    const sandbox = options?.sandbox ?? resolveSandboxConfig({ sandbox: true }, root);
    const bindingName =
      options?.bindingNames?.sandbox ?? sandbox?.binding ?? DEFAULT_SANDBOX_BINDING;
    const className = sandbox?.className ?? 'Sandbox';
    const existingDurableObjectBindings =
      ((
        parsed.durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined
      )?.bindings as Array<{ name: string; class_name: string }> | undefined) ?? [];
    if (!existingDurableObjectBindings.some((binding) => binding.name === bindingName)) {
      parsed.durable_objects = {
        bindings: [
          ...existingDurableObjectBindings,
          {
            name: bindingName,
            class_name: className,
          },
        ],
      };
      modified = true;
    }

    const existingContainers =
      (parsed.containers as Array<{ name?: string; class_name?: string }> | undefined) ?? [];
    if (!existingContainers.some((container) => container.class_name === className)) {
      parsed.containers = [
        ...existingContainers,
        {
          name: sandbox?.containerName ?? 'void-sandbox',
          class_name: className,
          image: sandbox?.image,
          ...(sandbox?.imageBuildContext && {
            image_build_context: sandbox.imageBuildContext,
          }),
          ...(sandbox?.instanceType && { instance_type: sandbox.instanceType }),
          ...(sandbox?.maxInstances != null && { max_instances: sandbox.maxInstances }),
        },
      ];
      modified = true;
    }

    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<{
          tag?: string;
          new_classes?: Array<string>;
          new_sqlite_classes?: Array<string>;
        }>)
      : [];
    const hasMigration = migrations.some(
      (migration) =>
        migration.tag === SANDBOX_MIGRATION_TAG ||
        migration.new_sqlite_classes?.includes(className),
    );
    if (!hasMigration) {
      parsed.migrations = [
        ...migrations,
        {
          tag: SANDBOX_MIGRATION_TAG,
          new_sqlite_classes: [className],
        },
      ];
      modified = true;
    }
  }

  if (bindings.needsLive || options?.live) {
    const existingDurableObjectBindings =
      ((
        parsed.durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined
      )?.bindings as Array<{ name: string; class_name: string }> | undefined) ?? [];
    const liveConfig =
      typeof options?.live === 'object'
        ? options.live
        : resolveLiveBindingConfig(root, {
            existingBindings: existingDurableObjectBindings,
            reservedBindings: options?.websockets?.map((route) => route.bindingName),
            reservedClasses: [
              ...(options?.websockets?.map((route) => route.className) ?? []),
              options?.sandbox?.className,
            ],
          });
    if (!existingDurableObjectBindings.some((binding) => binding.name === liveConfig.bindingName)) {
      parsed.durable_objects = {
        bindings: [
          ...existingDurableObjectBindings,
          {
            name: liveConfig.bindingName,
            class_name: liveConfig.className,
          },
        ],
      };
      modified = true;
    }

    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<DurableObjectMigration>)
      : [];
    const hasMigration = hasDurableObjectSqliteMigration(migrations, liveConfig.className);
    if (!hasMigration) {
      parsed.migrations = [
        ...migrations,
        {
          tag: nextDurableObjectMigrationTag(migrations, LIVE_MIGRATION_TAG),
          new_sqlite_classes: [liveConfig.className],
        },
      ];
      modified = true;
    }
  }

  if (created || modified) {
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
  }

  return created || modified;
}

/**
 * Ensure a wrangler config has an explicit compatibility date.
 * Used when `worker.compatibility_date` is configured in void.json but the
 * active framework reads Cloudflare settings from wrangler.jsonc/json.
 */
export function ensureWranglerCompatibilityDate(root: string, compatibilityDate: string): boolean {
  validateCompatDate(compatibilityDate, 'void.json worker config');

  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        parsed = parseJsonc(readFileSync(p, 'utf-8'));
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, 'wrangler.jsonc');
    parsed = {};
  }

  if (parsed.compatibility_date === compatibilityDate) {
    return false;
  }

  parsed.compatibility_date = compatibilityDate;
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return true;
}

/**
 * Ensure the `nodejs_als` compatibility flag exists in wrangler config.
 * Returns true if the config file was modified.
 */
export function ensureWranglerNodejsAlsFlag(root: string): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        parsed = parseJsonc(readFileSync(p, 'utf-8'));
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, 'wrangler.jsonc');
    parsed = {};
  }

  const compatibilityFlags = Array.isArray(parsed.compatibility_flags)
    ? (parsed.compatibility_flags as Array<unknown>)
    : [];
  if (compatibilityFlags.includes(NODEJS_ALS_FLAG)) {
    return false;
  }

  parsed.compatibility_flags = [...compatibilityFlags, NODEJS_ALS_FLAG];
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
  return true;
}

/** A wrangler `queues.producers[]` entry (written verbatim). */
export type WranglerQueueProducer = {
  queue: string;
  binding: string;
};

/**
 * A wrangler `queues.consumers[]` entry (written verbatim, snake_case wrangler
 * keys). Mirrors exactly what Void's queue scanner / `mergeBindings` emit.
 */
export type WranglerQueueConsumer = {
  queue: string;
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  retry_delay?: number;
};

/**
 * Patch describing the root-config gaps that `wrangler <res> create
 * --update-config` does NOT fill. `writeProvisionedWranglerConfig` applies these
 * to the project's root `wrangler.jsonc`/`wrangler.json`.
 *
 * Queues — per-app-class behavior (verified against `index.ts`/`deploy.ts`):
 *
 *   - NATIVE Void mode (no meta-framework; `detectFramework` → undefined):
 *     `mergeBindings` (`index.ts`) emits scanner-derived `queues.producers`/
 *     `consumers` into `dist/ssr/wrangler.json`, and `@cloudflare/vite-plugin`
 *     `defu`-merges the plugin config over the root config (arrays CONCATENATE).
 *     So the caller must NOT pass `queues` for a native app — it would DUPLICATE
 *     the scanner's entries. Leave `queues` undefined; the build binds them.
 *
 *   - FRAMEWORK mode (Class A: `index.ts:738` forces `queues = []`; Class B/C:
 *     the plugin returns before `mergeBindings` runs): the build emits NO queue
 *     bindings, yet the queue feature IS supported in production — the deploy
 *     wrapper (`cli/wrapper.ts`) adds a `queue: handleQueue` consumer to the
 *     framework worker. On self-host there is no Void platform to bind the
 *     queues, and `wrangler queues create` has no `--update-config`, so the
 *     orchestrator (Task 6) passes the inferred producers/consumers here to
 *     bind them in the root config for framework self-host builds only.
 */
export type ProvisionedWranglerPatch = {
  /** Cloudflare account id → top-level `account_id` (always overwritten). */
  accountId?: string;
  /** Worker name → top-level `name` (only written when absent). */
  name?: string;
  /** Compatibility date → top-level `compatibility_date` (only written when absent). */
  compatibilityDate?: string;
  /**
   * Adds `migrations_dir` to the `d1_databases[]` entry whose `binding` matches.
   * The D1 entry itself is created by `wrangler d1 create --update-config`; this
   * only fills its `migrations_dir`.
   */
  d1MigrationsDir?: { binding: string; dir: string };
  /**
   * Queue producer/consumer bindings, upserted into `queues.producers[]` /
   * `queues.consumers[]` idempotently (producers matched by `binding`, consumers
   * by `queue` — never duplicated on re-run).
   *
   * FRAMEWORK self-host ONLY. See the per-app-class note on this type: a native
   * Void app already emits scanner queues from the build, so passing `queues`
   * for one would duplicate them via the `defu` array concat.
   */
  queues?: {
    producers?: Array<WranglerQueueProducer>;
    consumers?: Array<WranglerQueueConsumer>;
  };
};

export type WriteProvisionedWranglerResult = {
  /** Absolute path of the config file that was operated on. */
  configPath: string;
  /** True when the file content changed (or a new file was created). */
  modified: boolean;
  /**
   * True when `d1MigrationsDir` was requested but no `d1_databases[]` entry with
   * the given binding existed. The orchestrator controls ordering — the D1
   * entry is created by `wrangler d1 create --update-config` first, so a skip
   * signals the writer ran before provisioning that binding.
   */
  d1MigrationsDirSkipped: boolean;
};

/**
 * Fill the parts of the root wrangler config that `wrangler <res> create
 * --update-config` leaves blank: top-level `account_id`, `name`,
 * `compatibility_date`, and `migrations_dir` on a specific D1 entry.
 *
 * Comment-preserving: uses `jsonc-parser` `modify()` + `applyEdits()` so
 * comments and unrelated content survive (unlike `syncWranglerBindings`, which
 * round-trips through `JSON.stringify` and strips comments). Every edit is an
 * idempotent upsert — running twice produces byte-identical output.
 */
export function writeProvisionedWranglerConfig(
  root: string,
  patch: ProvisionedWranglerPatch,
): WriteProvisionedWranglerResult {
  // Resolve the root config file (same discovery idiom as the rest of this
  // file: prefer wrangler.jsonc, fall back to wrangler.json, else create
  // wrangler.jsonc).
  let configPath: string | undefined;
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      break;
    }
  }
  configPath ??= join(root, 'wrangler.jsonc');

  // Node's utf-8 read preserves a leading BOM; wrangler itself strips the BOM
  // before parsing. Match that: strip it for parsing/editing, then re-add it on
  // write so the file's bytes round-trip unchanged.
  const rawContent = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  const hasBom = rawContent.startsWith(UTF8_BOM);
  const original = hasBom ? rawContent.slice(UTF8_BOM.length) : rawContent;

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonc(original);
  } catch (error) {
    // Fail closed. Never treat an unparseable config as `{}`: that would let the
    // only-if-absent logic clobber an existing `name`/`compatibility_date`, miss
    // real `d1_databases[]` entries, and rewrite a malformed file. Throw without
    // writing so the caller surfaces the problem instead of corrupting the file.
    throw new Error(
      `deploy: cannot update "${configPath}" — it is not valid JSON/JSONC. ` +
        `Fix the file and retry. (${(error as Error).message})`,
    );
  }

  // Fail closed on duplicate member names BEFORE any edit. jsonc-parser's
  // `parse()` resolves a duplicate key to the LAST member (the value wrangler
  // itself reads), but `modify()` edits the FIRST. So an upsert would compare
  // against the effective (last) value, patch the shadowed (first) member, and
  // leave wrangler reading the stale value — while a re-run finds the effective
  // value still unchanged, re-patches the already-correct first member, and
  // returns `modified: false`, looking byte-idempotent even though the requested
  // production setting was NEVER applied. This is config-wide (a duplicate
  // `account_id`, `compatibility_date`, a queue consumer's `max_batch_size`,
  // etc.). Throwing without writing surfaces the problem instead of silently
  // mis-editing (matches the malformed-config guard above). We do not "target
  // the last member": that would leave a malformed, still-duplicated file.
  assertNoDuplicateMembers(original, configPath);

  const formattingOptions = detectFormattingOptions(original);
  let text = original;
  const set = (path: Array<string | number>, value: unknown): void => {
    text = applyEdits(text, modify(text, path, value, { formattingOptions }));
  };

  // account_id — always overwrite so a re-resolve can correct a stale value.
  if (patch.accountId !== undefined) {
    set(['account_id'], patch.accountId);
  }

  // name / compatibility_date — only when absent (never clobber the user's).
  if (patch.name !== undefined && parsed.name === undefined) {
    set(['name'], patch.name);
  }
  if (patch.compatibilityDate !== undefined && parsed.compatibility_date === undefined) {
    set(['compatibility_date'], patch.compatibilityDate);
  }

  // migrations_dir — upsert onto the D1 entry matched by binding. Indices are
  // stable because we only set a property (never insert/reorder array entries).
  let d1MigrationsDirSkipped = false;
  if (patch.d1MigrationsDir) {
    const d1Entries = Array.isArray(parsed.d1_databases)
      ? (parsed.d1_databases as Array<{ binding?: unknown }>)
      : [];
    const index = d1Entries.findIndex((entry) => entry.binding === patch.d1MigrationsDir!.binding);
    if (index >= 0) {
      set(['d1_databases', index, 'migrations_dir'], patch.d1MigrationsDir.dir);
    } else {
      d1MigrationsDirSkipped = true;
    }
  }

  // queues — idempotent upsert into `queues.producers[]` / `queues.consumers[]`.
  // Producers key on `binding`, consumers on `queue`. Framework self-host only
  // (see the note on ProvisionedWranglerPatch); a native app would duplicate the
  // build's scanner queues.
  const upsertQueueEntries = (
    section: 'producers' | 'consumers',
    matchKey: 'binding' | 'queue',
    entries: Array<Record<string, unknown>> | undefined,
  ): void => {
    if (!entries || entries.length === 0) {
      return;
    }
    // Re-parse `text` (not the initial `parsed`) so earlier edits in this call
    // are reflected; track appends locally to keep indices valid.
    const currentQueues = parseJsonc(text).queues as Record<string, unknown> | undefined;
    const currentList = Array.isArray(currentQueues?.[section])
      ? [...(currentQueues[section] as Array<Record<string, unknown>>)]
      : [];
    for (const entry of entries) {
      const index = currentList.findIndex(
        (existing) => isRecord(existing) && existing[matchKey] === entry[matchKey],
      );
      if (index >= 0) {
        // Update ONLY the properties this patch supplies — never replace the
        // whole array element. A whole-object `modify()` at the element index
        // would drop inline comments AND any sibling fields the narrower
        // inferred patch omits (producer `delivery_delay`; consumer
        // `dead_letter_queue`, `max_concurrency`, …), silently changing
        // production delivery/retry/concurrency/failure-routing. Per-property
        // edits preserve unmentioned fields and comments, and stay idempotent
        // (a re-run finds each value already equal and writes nothing).
        const existing = isRecord(currentList[index]) ? currentList[index] : {};
        for (const [key, value] of Object.entries(entry)) {
          if (value === undefined) {
            continue;
          }
          if (!jsonEqual(existing[key], value)) {
            set(['queues', section, index, key], value);
          }
        }
        currentList[index] = { ...existing, ...entry };
      } else {
        // `isArrayInsertion` appends at `currentList.length`; it also creates the
        // `queues` object and the section array when they don't exist yet.
        text = applyEdits(
          text,
          modify(text, ['queues', section, currentList.length], entry, {
            formattingOptions,
            isArrayInsertion: true,
          }),
        );
        currentList.push(entry);
      }
    }
  };
  if (patch.queues) {
    upsertQueueEntries('producers', 'binding', patch.queues.producers);
    upsertQueueEntries('consumers', 'queue', patch.queues.consumers);
  }

  const finalText = hasBom ? `${UTF8_BOM}${text}` : text;
  const modified = finalText !== rawContent;
  if (modified) {
    writeFileSync(configPath, finalText);
  }
  return { configPath, modified, d1MigrationsDirSkipped };
}

/**
 * Detect indentation from an existing config so `jsonc-parser` formats inserted
 * content to match. Falls back to two-space indentation (the repo default).
 */
function detectFormattingOptions(text: string): FormattingOptions {
  const match = text.match(/^([ \t]+)\S/m);
  if (match) {
    const indent = match[1];
    if (indent.startsWith('\t')) {
      return { tabSize: 1, insertSpaces: false };
    }
    return { tabSize: indent.length, insertSpaces: true };
  }
  return { tabSize: 2, insertSpaces: true };
}

function parseJsonc(text: string): Record<string, unknown> {
  const errors: Array<ParseError> = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SyntaxError('Failed to parse JSONC');
  }
  return result;
}

/**
 * Throw (without writing) if any object in the config declares the same member
 * name twice. See the call site for why a duplicate makes property-level upserts
 * silently ineffective. Walks the jsonc AST so nested objects (queue consumers,
 * D1 entries, …) are covered, not just the top level.
 */
function assertNoDuplicateMembers(text: string, configPath: string): void {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (!root) {
    return;
  }
  const walk = (node: Node): void => {
    if (node.type === 'object' && node.children) {
      const seen = new Set<string>();
      for (const property of node.children) {
        const keyNode = property.children?.[0];
        const key = keyNode?.value;
        if (typeof key !== 'string') {
          continue;
        }
        if (seen.has(key)) {
          const { line, column } = offsetToLineColumn(text, keyNode!.offset);
          throw new Error(
            `deploy: cannot update "${configPath}" — duplicate key ${JSON.stringify(key)} ` +
              `at line ${line}, column ${column}. Wrangler reads the last of two duplicate ` +
              `members, but this writer edits the first, so the update would silently not ` +
              `apply. Remove the duplicate and retry.`,
          );
        }
        seen.add(key);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

/** 1-based line/column for a byte offset — used in duplicate-key error messages. */
function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Order-insensitive structural equality — avoids rewriting an entry that only
 * differs in key order (preserves the file's bytes/comments on that entry). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
