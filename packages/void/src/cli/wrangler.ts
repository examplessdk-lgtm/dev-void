import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { appendSqliteClassMigration, type DurableObjectMigrationStep } from '@void/deploy-core';
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  SyntaxKind,
  type FormattingOptions,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { basename, dirname, join, normalize } from 'pathslash';
import {
  materializeCloudflareConfig,
  MATERIALIZED_CLOUDFLARE_FILE,
  persistCloudflareConfig,
} from '../cloudflare-config.ts';
import { TYPED_CONFIG_FILE } from '../config-loader.ts';
import { readConfig, type VoidConfig } from '../config.ts';
import type { DurableObjectModule } from '../durable/scan.ts';
import type { InferredBindings } from '../inference/walk.ts';
import type { WebSocketRouteDefinition } from '../router/websocket.ts';
import {
  DEFAULT_SANDBOX_BINDING,
  SANDBOX_MIGRATION_TAG,
  assertSandboxNamespaceConfig,
  hasSandboxSqliteMigration,
  resolveSandboxConfig,
  sandboxContainerConfig,
  type ResolvedSandboxConfig,
} from '../sandbox/config.ts';

const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** UTF-8 byte-order mark. Node's utf-8 read preserves a leading one. */
const UTF8_BOM = '﻿';
const NODEJS_ALS_FLAG = 'nodejs_als';
const NODEJS_COMPAT_FLAG = 'nodejs_compat';
const VOID_CONFIG_FILE = 'void.json';

function projectWranglerPaths(root: string): Array<string> {
  if (existsSync(join(root, TYPED_CONFIG_FILE))) {
    return [materializeCloudflareConfig(root)];
  }
  return ['wrangler.jsonc', 'wrangler.json'].map((name) => join(root, name));
}

function writeProjectWranglerFile(configPath: string, text: string): void {
  writeFileSync(configPath, text);
  if (basename(configPath) === MATERIALIZED_CLOUDFLARE_FILE) {
    persistCloudflareConfig(dirname(configPath));
  }
}
const MANAGED_QUEUES_MARKER = /^\s*\/\/ void:managed-queues:v1:([A-Za-z0-9_-]+)\s*$/m;
const PUBLISHED_TRAFFIC_MARKER = /^\s*\/\/ void:published-traffic:v1:([A-Za-z0-9_-]+)\s*$/m;
export const DEFAULT_LIVE_BINDING = 'VOID_LIVE';
export const DEFAULT_LIVE_CLASS = 'VoidLiveStreamDurableObject';
export const LIVE_MIGRATION_TAG = 'live-v1';

export type WranglerCustomDomain = {
  pattern: string;
  customDomain: true;
};

export type WranglerCustomDomainUpdate = {
  configPath: string;
  domains: Array<WranglerCustomDomain>;
  modified: boolean;
};

export type WranglerPublishedTrafficSnapshot = {
  workers_dev: boolean;
  preview_urls: boolean;
  routes: Array<unknown>;
};

export type RootWranglerConfig = {
  configPath: string;
  config: Record<string, unknown>;
};

/** Read the root Wrangler config with the same JSONC parser used by binding sync. */
export function readRootWranglerConfig(root: string): RootWranglerConfig | undefined {
  for (const configPath of projectWranglerPaths(root)) {
    if (!existsSync(configPath)) {
      continue;
    }
    const parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SyntaxError(`Failed to parse ${configPath}: expected a JSON object.`);
    }
    return { configPath, config: parsed };
  }
  return undefined;
}

/** Read the last traffic attachment state Void successfully published remotely. */
export function readWranglerPublishedTrafficSnapshot(
  configPath: string,
): WranglerPublishedTrafficSnapshot | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const encoded = PUBLISHED_TRAFFIC_MARKER.exec(readFileSync(configPath, 'utf-8'))?.[1];
  if (!encoded) {
    return undefined;
  }
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (
      !isRecord(value) ||
      typeof value.workers_dev !== 'boolean' ||
      typeof value.preview_urls !== 'boolean' ||
      !Array.isArray(value.routes)
    ) {
      return undefined;
    }
    return {
      workers_dev: value.workers_dev,
      preview_urls: value.preview_urls,
      routes: value.routes,
    };
  } catch {
    return undefined;
  }
}

/** Persist traffic attachment provenance without adding unsupported Wrangler fields. */
export function writeWranglerPublishedTrafficSnapshot(
  configPath: string,
  snapshot: WranglerPublishedTrafficSnapshot,
  options?: { create?: boolean },
): void {
  if (!existsSync(configPath)) {
    return;
  }
  const raw = readFileSync(configPath, 'utf-8');
  const encoded = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64url');
  const marker = `// void:published-traffic:v1:${encoded}`;
  const existing = PUBLISHED_TRAFFIC_MARKER.exec(raw);
  if (!existing && options?.create === false) {
    return;
  }
  const next = existing
    ? raw.slice(0, existing.index) + marker + raw.slice(existing.index + existing[0].length)
    : `${marker}${raw.includes('\r\n') ? '\r\n' : '\n'}${raw}`;
  if (next !== raw) {
    writeProjectWranglerFile(configPath, next);
  }
}

export type LiveBindingConfig = {
  bindingName: string;
  className: string;
};

type DurableObjectMigration = DurableObjectMigrationStep & {
  tag?: string;
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
  for (const path of projectWranglerPaths(root)) {
    try {
      const parsed = parseJsonc(readFileSync(path, 'utf-8'));
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
  for (const path of projectWranglerPaths(root)) {
    try {
      raw = readFileSync(path, 'utf-8');
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
  return existsSync(join(root, VOID_CONFIG_FILE)) || existsSync(join(root, TYPED_CONFIG_FILE))
    ? readConfig(root)
    : undefined;
}

function ensureVoidCompatibilityDate(root: string, config?: VoidConfig): string {
  if (existsSync(join(root, TYPED_CONFIG_FILE))) {
    writeProvisionedWranglerConfig(root, { compatibilityDate: LATEST_KNOWN_COMPAT_DATE });
    return LATEST_KNOWN_COMPAT_DATE;
  }
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
    bindingNames?: { d1?: string; kv?: string; r2?: string; ai?: string; sandbox?: string };
    directCloudflareAi?: { gateway?: string };
    durableObjects?: Array<DurableObjectModule>;
    websockets?: Array<WebSocketRouteDefinition>;
    sandbox?: ResolvedSandboxConfig;
    live?: boolean | LiveBindingConfig;
  },
): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  let created = false;
  for (const p of projectWranglerPaths(root)) {
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
    configPath = materializeCloudflareConfig(root);
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

  // Framework adapters read bindings from the root Wrangler config. Workers AI
  // has no local simulator, so direct Cloudflare development needs remote mode.
  // Managed projects keep using Void's proxy and do not gain a billable binding.
  if (bindings.needsAI && options?.directCloudflareAi) {
    const existing = parsed.ai as Record<string, unknown> | undefined;
    const binding =
      typeof existing?.binding === 'string' ? existing.binding : (options.bindingNames?.ai ?? 'AI');
    const nextAi = { ...(existing ?? {}), binding, remote: true };
    if (JSON.stringify(existing) !== JSON.stringify(nextAi)) {
      parsed.ai = nextAi;
      modified = true;
    }
    if (binding !== 'AI' || options.directCloudflareAi.gateway) {
      const vars = (parsed.vars as Record<string, unknown> | undefined) ?? {};
      const nextVars = {
        ...vars,
        ...(binding !== 'AI' ? { __VOID_AI_BINDING: binding } : {}),
        ...(options.directCloudflareAi.gateway
          ? { __VOID_AI_GATEWAY: options.directCloudflareAi.gateway }
          : {}),
      };
      if (JSON.stringify(vars) !== JSON.stringify(nextVars)) {
        parsed.vars = nextVars;
        modified = true;
      }
    }
  }

  if (options?.websockets) {
    const existing =
      ((
        parsed.durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined
      )?.bindings as Array<{ name: string; class_name: string }> | undefined) ?? [];
    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<DurableObjectMigration>)
      : [];
    // Registered Durable Object classes are data-bearing identities. Removing a
    // route must not remove its binding or emit `deleted_classes`: either action
    // can make the next upload invalid or destroy the object's SQLite storage.
    // Historical WebSocket bindings remain attached and the compiler exports a
    // tombstone class until an explicit destructive lifecycle command exists.
    const retained = existing;
    for (const route of options.websockets) {
      const conflict = retained.find(
        (binding) => binding.name === route.bindingName && binding.class_name !== route.className,
      );
      if (conflict) {
        throw new Error(
          `websocket: binding '${route.bindingName}' is already configured for class '${conflict.class_name}', but '${route.filePath}' requires '${route.className}'.`,
        );
      }
    }
    const additions = options.websockets
      .filter((route) => !retained.some((binding) => binding.name === route.bindingName))
      .map((route) => ({ name: route.bindingName, class_name: route.className }));
    const nextBindings = [...retained, ...additions];
    if (
      nextBindings.length !== existing.length ||
      nextBindings.some(
        (binding, index) =>
          binding.name !== existing[index]?.name ||
          binding.class_name !== existing[index]?.class_name,
      )
    ) {
      parsed.durable_objects = {
        ...((parsed.durable_objects as Record<string, unknown> | undefined) ?? {}),
        bindings: nextBindings,
      };
      modified = true;
    }

    const planned = appendSqliteClassMigration(
      migrations,
      options.websockets.map((route) => route.className),
      'void-ws-v1',
      retained.map((binding) => binding.class_name),
    );
    if (planned.added) {
      parsed.migrations = planned.migrations;
      modified = true;
    }
  }

  if (options?.durableObjects && options.durableObjects.length > 0) {
    const existingBindings =
      ((
        parsed.durable_objects as
          | { bindings?: Array<{ name: string; class_name: string }> }
          | undefined
      )?.bindings as Array<{ name: string; class_name: string }> | undefined) ?? [];
    for (const module of options.durableObjects) {
      const conflict = existingBindings.find(
        (binding) => binding.name === module.bindingName && binding.class_name !== module.className,
      );
      if (conflict) {
        throw new Error(
          `durable: binding '${module.bindingName}' is already configured for class '${conflict.class_name}', but durable-objects/ requires '${module.className}'.`,
        );
      }
    }
    const additions = options.durableObjects
      .filter((module) => !existingBindings.some((binding) => binding.name === module.bindingName))
      .map((module) => ({ name: module.bindingName, class_name: module.className }));
    if (additions.length > 0) {
      parsed.durable_objects = { bindings: [...existingBindings, ...additions] };
      modified = true;
    }

    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<DurableObjectMigration>)
      : [];
    for (const module of options.durableObjects) {
      const tagConflict = migrations.find(
        (migration) =>
          migration.tag === module.migrationTag &&
          !migration.new_sqlite_classes?.includes(module.className),
      );
      if (tagConflict) {
        throw new Error(
          `durable: migration tag '${module.migrationTag}' is already used by another Durable Object migration.`,
        );
      }
      if (!hasDurableObjectSqliteMigration(migrations, module.className)) {
        migrations.push({
          tag: module.migrationTag,
          new_sqlite_classes: [module.className],
        });
        modified = true;
      }
    }
    if (modified) {
      parsed.migrations = migrations;
    }
  }

  if (bindings.needsSandbox) {
    const sandbox = options?.sandbox ?? resolveSandboxConfig({ sandbox: true }, root);
    const bindingName =
      options?.bindingNames?.sandbox ?? sandbox?.binding ?? DEFAULT_SANDBOX_BINDING;
    const className = sandbox.className;
    assertSandboxNamespaceConfig(parsed, sandbox);
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
    const containers = [
      ...existingContainers.filter((container) => container.class_name !== className),
      sandboxContainerConfig(sandbox),
    ];
    if (JSON.stringify(containers) !== JSON.stringify(existingContainers)) {
      parsed.containers = containers;
      modified = true;
    }

    const migrations = Array.isArray(parsed.migrations)
      ? (parsed.migrations as Array<{
          tag?: string;
          new_classes?: Array<string>;
          new_sqlite_classes?: Array<string>;
        }>)
      : [];
    const hasMigration = hasSandboxSqliteMigration(migrations, className);
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
    writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
  }

  return created || modified;
}

const NO_INFERRED_BINDINGS: InferredBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
  needsLive: false,
};

/** Persist convention-derived Durable Object bindings and append-only migration history. */
export function syncWranglerDurableObjects(
  root: string,
  durableObjects: Array<DurableObjectModule>,
): boolean {
  if (durableObjects.length === 0) {
    return false;
  }
  return syncWranglerBindings(root, NO_INFERRED_BINDINGS, { durableObjects });
}

/** Persist WebSocket Durable Object bindings and SQLite migration history. */
export function syncWranglerWebSockets(
  root: string,
  websockets: Array<WebSocketRouteDefinition>,
): boolean {
  if (websockets.length === 0 && !projectWranglerPaths(root).some((path) => existsSync(path))) {
    return false;
  }
  return writeProvisionedWranglerConfig(root, { webSockets: websockets }).modified;
}

/**
 * Return registered WebSocket classes that no longer have a source route.
 * These classes must remain exported while their data-bearing bindings remain
 * in Wrangler configuration. Arbitrary user Durable Objects are excluded by
 * requiring provenance from Void's WebSocket migration tag.
 */
export function readWranglerWebSocketTombstones(
  root: string,
  websockets: Array<WebSocketRouteDefinition>,
): Array<string> {
  const configPath = projectWranglerPaths(root).find((path) => existsSync(path));
  if (!configPath) {
    return [];
  }
  const parsed = parseJsonc(readFileSync(configPath, 'utf-8'));
  const migrations = Array.isArray(parsed.migrations)
    ? (parsed.migrations as Array<DurableObjectMigration>)
    : [];
  const historicalClasses = new Set(
    migrations.flatMap((migration) =>
      /^void-ws-v1(?:-\d+)?$/.test(migration.tag ?? '')
        ? [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])]
        : [],
    ),
  );
  const currentClasses = new Set(websockets.map((route) => route.className));
  const bindings = (
    parsed.durable_objects as { bindings?: Array<{ class_name?: unknown }> } | undefined
  )?.bindings;
  return [
    ...new Set(
      (Array.isArray(bindings) ? bindings : []).flatMap((binding) =>
        typeof binding.class_name === 'string' &&
        historicalClasses.has(binding.class_name) &&
        !currentClasses.has(binding.class_name)
          ? [binding.class_name]
          : [],
      ),
    ),
  ].sort();
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
  for (const p of projectWranglerPaths(root)) {
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
    configPath = materializeCloudflareConfig(root);
    parsed = {};
  }

  if (parsed.compatibility_date === compatibilityDate) {
    return false;
  }

  parsed.compatibility_date = compatibilityDate;
  writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
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
  for (const p of projectWranglerPaths(root)) {
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
    configPath = materializeCloudflareConfig(root);
    parsed = {};
  }

  const compatibilityFlags = Array.isArray(parsed.compatibility_flags)
    ? (parsed.compatibility_flags as Array<unknown>)
    : [];
  if (compatibilityFlags.includes(NODEJS_ALS_FLAG)) {
    return false;
  }

  parsed.compatibility_flags = [...compatibilityFlags, NODEJS_ALS_FLAG];
  writeProjectWranglerFile(configPath, JSON.stringify(parsed, null, 2) + '\n');
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
  /** Compatibility flags to add without removing existing flags. */
  compatibilityFlags?: Array<string>;
  /**
   * Adds `migrations_dir` to the `d1_databases[]` entry whose `binding` matches.
   * The D1 entry itself is created by `wrangler d1 create --update-config`; this
   * only fills its `migrations_dir`.
   */
  d1MigrationsDir?: { binding: string; dir: string };
  /**
   * ADOPT an already-existing resource: write its REAL id/name into the config
   * entry matched by `binding`, creating the entry (and its array) if absent.
   *
   * These exist because `wrangler <res> create --update-config` — which is what
   * writes the id on the CREATE path — cannot run when the resource already
   * exists in the account (create errors on a name collision). So on the adopt
   * path the provisioner captures the id via `wrangler <res> list/info --json`
   * and routes it through here, keeping every comment-preserving jsonc write in
   * this one writer. Each is an idempotent, comment-preserving property upsert
   * (byte-identical on re-run) that never touches sibling fields.
   */
  d1?: { binding: string; databaseName: string; databaseId: string };
  kv?: { binding: string; id: string };
  r2?: { binding: string; bucketName: string };
  hyperdrive?: { binding: string; id: string };
  /** Persist WebSocket bindings and append-only Durable Object migration history. */
  webSockets?: Array<Pick<WebSocketRouteDefinition, 'bindingName' | 'className' | 'filePath'>>;
  /**
   * Queue producer/consumer bindings, upserted into `queues.producers[]` /
   * `queues.consumers[]` idempotently, keyed by each section's wrangler identity
   * so re-runs never duplicate:
   *
   *   - Producers are matched by `binding`. wrangler requires producer binding
   *     names to be UNIQUE across the worker (multiple producers may legally
   *     target one queue), so the binding — not the queue — is the identity.
   *     Void's binding is the deterministic `QUEUE_<NAME>`. A missing binding is
   *     APPENDED (never rewriting a user's own same-queue producer); a binding
   *     already bound to a DIFFERENT queue fails closed (a binding must map to
   *     exactly one queue, else wrangler rejects the deploy).
   *   - Consumers are matched by `queue`. wrangler allows exactly one consumer
   *     per queue, so the queue name is the identity; matched entries are
   *     property-upserted (user-tuned fields preserved).
   *
   * FRAMEWORK self-host ONLY. See the per-app-class note on this type: a native
   * Void app already emits scanner queues from the build, so passing `queues`
   * for one would duplicate them via the `defu` array concat.
   */
  queues?: {
    producers?: Array<WranglerQueueProducer>;
    consumers?: Array<WranglerQueueConsumer>;
    /** Remove only stale entries carrying explicit Void-managed provenance. */
    reconcileVoidOwned?: boolean;
  };
  /**
   * Email (Mode B — the developer's own Cloudflare account; design doc 0078).
   *
   * `sendEmail` upserts `{ name }` into the top-level `send_email[]` array, keyed by
   * `name` (wrangler's identity for that field — it has no `.binding`). A matched
   * entry is left exactly as it is (its `destination_address` /
   * `allowed_destination_addresses` are user-owned); a missing one is appended and
   * the array is created when absent. Other entries are never touched.
   */
  sendEmail?: { name: string };
  /**
   * The top-level `addresses` string array wrangler ≥ 4.113 reconciles Email
   * Routing rules from on `wrangler deploy`. Void OWNS the whole array in Mode B
   * (decision 13), so this is a whole-array write, not a merge:
   *   - `string[]` → set the array to exactly this value (rewritten every run);
   *   - `null`     → delete the key (routing is not ready — an EMPTY array would
   *                  delete every rule wrangler owns, so the key must go instead);
   *   - `undefined`→ untouched.
   */
  addresses?: Array<string> | null;
  /**
   * Top-level `vars` to upsert by key (e.g. `__VOID_EMAIL_FROM`). Existing keys
   * with a different value are overwritten; other keys are untouched; the `vars`
   * object is created when absent.
   */
  vars?: Record<string, string>;
};

type ManagedQueueProvenance = {
  producerBindings: Array<string>;
  consumerQueues: Array<string>;
  /** Void-owned consumers removed locally but not yet confirmed removed remotely. */
  pendingConsumerRemovals: Array<string>;
};

function readManagedQueueProvenance(text: string): ManagedQueueProvenance {
  const encoded = MANAGED_QUEUES_MARKER.exec(text)?.[1];
  if (!encoded) {
    return { producerBindings: [], consumerQueues: [], pendingConsumerRemovals: [] };
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed)) {
      return { producerBindings: [], consumerQueues: [], pendingConsumerRemovals: [] };
    }
    return {
      producerBindings: Array.isArray(parsed.producerBindings)
        ? parsed.producerBindings.filter((value): value is string => typeof value === 'string')
        : [],
      consumerQueues: Array.isArray(parsed.consumerQueues)
        ? parsed.consumerQueues.filter((value): value is string => typeof value === 'string')
        : [],
      pendingConsumerRemovals: Array.isArray(parsed.pendingConsumerRemovals)
        ? parsed.pendingConsumerRemovals.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    };
  } catch {
    // A malformed marker proves no ownership. Fail safe by retaining every entry.
    return { producerBindings: [], consumerQueues: [], pendingConsumerRemovals: [] };
  }
}

function writeManagedQueueProvenance(text: string, provenance: ManagedQueueProvenance): string {
  const normalized: ManagedQueueProvenance = {
    producerBindings: [...new Set(provenance.producerBindings)].sort(),
    consumerQueues: [...new Set(provenance.consumerQueues)].sort(),
    pendingConsumerRemovals: [...new Set(provenance.pendingConsumerRemovals)].sort(),
  };
  const existing = MANAGED_QUEUES_MARKER.exec(text);
  if (
    normalized.producerBindings.length === 0 &&
    normalized.consumerQueues.length === 0 &&
    normalized.pendingConsumerRemovals.length === 0
  ) {
    if (!existing) {
      return text;
    }
    const start = existing.index;
    const end = start + existing[0].length;
    const trailingNewline = text.slice(end).match(/^(\r?\n)/)?.[1] ?? '';
    return text.slice(0, start) + text.slice(end + trailingNewline.length);
  }
  const encoded = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  const marker = `// void:managed-queues:v1:${encoded}`;
  if (existing) {
    return text.slice(0, existing.index) + marker + text.slice(existing.index + existing[0].length);
  }
  return `${marker}${text.includes('\r\n') ? '\r\n' : '\n'}${text}`;
}

/**
 * Return explicitly Void-owned consumer names that may need remote cleanup.
 *
 * Current managed consumers are included for schema-1 upgrades; the activation layer subtracts
 * consumers still present in the desired config. Pending removals survive failed deploys so a
 * later retry can finish cleanup without inferring ownership from queue naming conventions.
 */
export function readWranglerManagedQueueCleanupCandidates(configPath: string): Array<string> {
  if (!existsSync(configPath)) {
    return [];
  }
  const raw = readFileSync(configPath, 'utf-8');
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const provenance = readManagedQueueProvenance(text);
  return [...new Set([...provenance.consumerQueues, ...provenance.pendingConsumerRemovals])].sort();
}

/** Clear only cleanup tombstones confirmed by a successful trigger reconciliation. */
export function acknowledgeWranglerManagedQueueRemovals(
  configPath: string,
  removedQueues: ReadonlyArray<string>,
): void {
  if (!existsSync(configPath) || removedQueues.length === 0) {
    return;
  }
  const raw = readFileSync(configPath, 'utf-8');
  const hasBom = raw.startsWith(UTF8_BOM);
  const text = hasBom ? raw.slice(UTF8_BOM.length) : raw;
  const provenance = readManagedQueueProvenance(text);
  const removed = new Set(removedQueues);
  const updated = writeManagedQueueProvenance(text, {
    ...provenance,
    pendingConsumerRemovals: provenance.pendingConsumerRemovals.filter(
      (queue) => !removed.has(queue),
    ),
  });
  const finalText = hasBom ? `${UTF8_BOM}${updated}` : updated;
  if (finalText !== raw) {
    writeProjectWranglerFile(configPath, finalText);
  }
}

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
 * Fill root Wrangler config fields required by generated/provisioned resources, including
 * append-only WebSocket Durable Object bindings and migrations, and Mode B email fields
 * (`send_email`, `addresses`, `vars`) that have no Wrangler command.
 *
 * Comment-preserving: uses `jsonc-parser` `modify()` + `applyEdits()` so
 * comments and unrelated content survive (unlike `syncWranglerBindings`, which
 * round-trips through `JSON.stringify` and strips comments). Every edit is an
 * idempotent upsert — running twice produces byte-identical output.
 */
export function writeProvisionedWranglerConfig(
  root: string,
  patch: ProvisionedWranglerPatch,
  options?: { configPath?: string },
): WriteProvisionedWranglerResult {
  // Resolve the root config file. When the caller pins an EXACT `configPath`
  // (the provisioner does, so its read-first parse, wrangler `-c`, and this
  // write all operate on the SAME file — no split-brain), honor it verbatim.
  // Otherwise fall back to the same discovery idiom as the rest of this file:
  // prefer wrangler.jsonc, fall back to wrangler.json, else create wrangler.jsonc.
  let configPath = options?.configPath;
  if (configPath === undefined) {
    for (const p of projectWranglerPaths(root)) {
      if (existsSync(p)) {
        configPath = p;
        break;
      }
    }
    configPath ??= materializeCloudflareConfig(root);
  }

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
  // Paths this call overwrites with a scalar. When a scalar-expected field
  // (account_id, migrations_dir, a queue option) already holds a COMPOSITE
  // object/array value, `jsonc-parser.modify()` replaces the whole node —
  // deleting any comment nested inside it while still reporting the edit as
  // applied. The final comment-preservation gate below uses these paths to name
  // the offending field when it detects such a drop.
  const scalarSetPaths: Array<Array<string | number>> = [];
  const set = (path: Array<string | number>, value: unknown): void => {
    scalarSetPaths.push(path);
    text = applyMemberEdit(text, path, value, { formattingOptions });
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
  if (patch.compatibilityFlags !== undefined) {
    const existingFlags = parsed.compatibility_flags;
    if (
      existingFlags !== undefined &&
      (!Array.isArray(existingFlags) ||
        !existingFlags.every((flag): flag is string => typeof flag === 'string'))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "compatibility_flags" must be an array of strings.`,
      );
    }
    const flags = existingFlags ?? [];
    for (const flag of patch.compatibilityFlags) {
      if (!flags.includes(flag)) {
        text = applyMemberEdit(text, ['compatibility_flags', flags.length], flag, {
          formattingOptions,
          isArrayInsertion: true,
        });
        flags.push(flag);
      }
    }
  }

  // Lazily-built map of EVERY binding name already used anywhere in the config
  // (keyed name → wrangler's friendly owner label). Used by the queue-producer
  // append guard further down; built from the CURRENT `text` at first use so it
  // reflects any adopt appended earlier in this call (not the stale initial
  // `parsed`). The adopt guard below rebuilds its own view per adopt (it must
  // include queues.producers, which this collector deliberately omits).
  let workerBindingOwners: Map<string, string> | undefined;

  if (patch.webSockets && patch.webSockets.length > 0) {
    const requested = new Map<string, (typeof patch.webSockets)[number]>();
    for (const route of patch.webSockets) {
      const existing = requested.get(route.bindingName);
      if (existing && existing.className !== route.className) {
        throw new Error(
          `websocket: binding '${route.bindingName}' resolves to both '${existing.className}' and '${route.className}'. Rename one of the route files.`,
        );
      }
      requested.set(route.bindingName, route);
    }

    const initialConfig = parseJsonc(text);
    const initialBindings = bindingEntriesForField(
      'durable_objects',
      initialConfig.durable_objects,
    );
    const knownExistingClasses = initialBindings.map(({ entry }, index) => {
      if (typeof entry.class_name !== 'string' || entry.class_name.length === 0) {
        throw new Error(
          `deploy: cannot update "${configPath}" — "durable_objects.bindings" entry at index ${index} is missing a non-empty string "class_name".`,
        );
      }
      return entry.class_name;
    });

    for (const route of requested.values()) {
      const currentConfig = parseJsonc(text);
      const durableObjectBindings = bindingEntriesForField(
        'durable_objects',
        currentConfig.durable_objects,
      );
      const matches = durableObjectBindings.filter(({ name }) => name === route.bindingName);
      if (matches.length > 1) {
        throw new Error(
          `deploy: cannot update "${configPath}" — Durable Object binding '${route.bindingName}' is declared more than once.`,
        );
      }
      if (matches.length === 1) {
        const entry = matches[0].entry;
        if (
          entry.class_name !== route.className ||
          entry.script_name !== undefined ||
          entry.environment !== undefined
        ) {
          throw new Error(
            `websocket: binding '${route.bindingName}' is already configured for another class, script, or environment, but '${route.filePath}' requires the local class '${route.className}'.`,
          );
        }
        continue;
      }

      const owners = collectWorkerBindingNames(
        configWithoutField(currentConfig, 'durable_objects'),
      );
      addQueueProducerOwners(owners, currentConfig);
      const owner = owners.get(route.bindingName);
      if (owner) {
        throw new Error(
          `deploy: cannot update "${configPath}" — WebSocket binding '${route.bindingName}' is already used by a ${owner} binding.`,
        );
      }
      text = applyMemberEdit(
        text,
        ['durable_objects', 'bindings', durableObjectBindings.length],
        { name: route.bindingName, class_name: route.className },
        { formattingOptions, isArrayInsertion: true },
      );
    }

    const currentConfig = parseJsonc(text);
    const rawMigrations = currentConfig.migrations;
    const migrations = validateDurableObjectMigrations(rawMigrations, configPath);
    const planned = appendSqliteClassMigration(
      migrations,
      [...requested.values()].map((route) => route.className),
      'void-ws-v1',
      knownExistingClasses,
    );
    if (planned.added) {
      text = applyMemberEdit(
        text,
        ['migrations', migrations.length],
        planned.migrations[planned.migrations.length - 1],
        { formattingOptions, isArrayInsertion: true },
      );
    }
  }

  // Adopt fields — write the REAL id/name of an already-existing resource into
  // the binding's config entry (create the array + entry if absent), keyed by
  // `binding`. Runs BEFORE `migrations_dir` so an adopt that CREATES a D1 entry
  // is visible to the `migrations_dir` upsert below (which re-parses `text`).
  // Each is an idempotent property upsert: a matched entry has only the supplied
  // props set (siblings + comments preserved), a missing one is appended.
  //
  // The upsert upholds the SAME worker-wide binding invariants the producer path
  // enforces (see `validateBindingsHaveUniqueNames` mirror below):
  //   - >1 entry in the target array sharing `binding` → fail closed (ambiguous:
  //     adoption cannot pick which to write, and wrangler rejects the duplicate).
  //   - The binding is already used by ANOTHER binding type — a KV bound `DB`, a
  //     var, a secret, a QUEUE PRODUCER, … — whether we are APPENDING a new entry
  //     OR UPDATING an existing matched one → fail closed (a cross-type duplicate
  //     binding name wrangler rejects at deploy).
  //
  // `identityKey` is the member property wrangler keys the field on: `binding` for
  // the id-bearing resources, `name` for `send_email` (which has no `.binding` —
  // see `nameKeyedBindingNames`).
  const upsertAdoptedBinding = (
    field: string,
    binding: string,
    properties: Record<string, string>,
    identityKey: 'binding' | 'name' = 'binding',
  ): void => {
    // Re-parse the CURRENT text (not the initial `parsed`) so this sees any adopt
    // appended earlier in THIS call — a stale map would let a multi-field patch
    // adopt the same binding into two arrays without noticing the collision.
    const currentConfig = parseJsonc(text);
    const rawList = currentConfig[field];
    // Strictly validate the TARGET field's own shape too. The owner collector
    // below EXCLUDES this field (so the matched entry does not self-collide), so
    // without this a malformed member in the target array (e.g. a `null` beside a
    // valid `{binding}`) would be silently skipped by the match loop and could hide a
    // real duplicate binding. Reuse the ONE field-aware validator; it throws on any
    // malformed member (fail closed) before we mutate the array.
    bindingNamesForField(field, rawList);
    const currentList = Array.isArray(rawList) ? [...rawList] : [];
    const matches: Array<number> = [];
    for (let i = 0; i < currentList.length; i++) {
      const entry = currentList[i];
      if (isRecord(entry) && entry[identityKey] === binding) {
        matches.push(i);
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `deploy: cannot update "${configPath}" — binding ${JSON.stringify(binding)} is declared ` +
          `${matches.length} times in "${field}". Void cannot choose which entry to update, and ` +
          `wrangler rejects duplicate binding names. Remove the duplicate and retry.`,
      );
    }
    // Worker-wide cross-type uniqueness — checked for BOTH the matched (existing
    // target) and the append case: a binding shared with any OTHER binding type is
    // undeployable regardless of whether we create or update this entry. Build the
    // owner map from the CURRENT config, EXCLUDING the target field (its own
    // matched entry must not self-collide) and INCLUDING queues.producers (the base
    // collector omits producers so the producer path does not self-collide, but for
    // an adopt a producer sharing the binding IS a real cross-type collision).
    // Reuse the shared collector — do NOT fork it.
    const owners = collectWorkerBindingNames(configWithoutField(currentConfig, field));
    addQueueProducerOwners(owners, currentConfig);
    const owner = owners.get(binding);
    if (owner !== undefined) {
      throw new Error(
        `deploy: cannot update "${configPath}" — cannot adopt ${JSON.stringify(binding)} into ` +
          `"${field}" because that binding name is already used by a ${owner} binding. Wrangler ` +
          `requires every binding name to be unique across the whole worker, so this would make ` +
          `the config undeployable. Rename the conflicting binding and retry.`,
      );
    }
    if (matches.length === 1) {
      const index = matches[0];
      const existing = isRecord(currentList[index]) ? currentList[index] : {};
      for (const [key, value] of Object.entries(properties)) {
        if (!jsonEqual(existing[key], value)) {
          set([field, index, key], value);
        }
      }
    } else {
      text = applyMemberEdit(
        text,
        [field, currentList.length],
        { [identityKey]: binding, ...properties },
        {
          formattingOptions,
          isArrayInsertion: true,
        },
      );
    }
  };
  if (patch.d1) {
    upsertAdoptedBinding('d1_databases', patch.d1.binding, {
      database_name: patch.d1.databaseName,
      database_id: patch.d1.databaseId,
    });
  }
  if (patch.kv) {
    upsertAdoptedBinding('kv_namespaces', patch.kv.binding, { id: patch.kv.id });
  }
  if (patch.r2) {
    upsertAdoptedBinding('r2_buckets', patch.r2.binding, { bucket_name: patch.r2.bucketName });
  }
  if (patch.hyperdrive) {
    upsertAdoptedBinding('hyperdrive', patch.hyperdrive.binding, { id: patch.hyperdrive.id });
  }
  // send_email — the same name-keyed upsert: `{ name }` only, so a matched entry
  // keeps whatever destination restrictions the user put on it, and the worker-wide
  // uniqueness guard rejects a `SEND_EMAIL` name already held by another binding.
  if (patch.sendEmail) {
    upsertAdoptedBinding('send_email', patch.sendEmail.name, {}, 'name');
  }

  // migrations_dir — upsert onto the D1 entry matched by binding. Indices are
  // stable because we only set a property (never insert/reorder array entries).
  // Re-parse `text` (not the initial `parsed`) so a D1 entry an adopt just
  // created above is matched here too.
  let d1MigrationsDirSkipped = false;
  if (patch.d1MigrationsDir) {
    const currentD1 = parseJsonc(text).d1_databases;
    const d1Entries = Array.isArray(currentD1)
      ? (currentD1 as Array<{
          binding?: unknown;
          migrations_dir?: unknown;
          migrations_pattern?: unknown;
        }>)
      : [];
    // Require EXACTLY ONE D1 entry with the binding. `findIndex` (first match)
    // would silently accept DUPLICATE D1 bindings — a config wrangler rejects —
    // and attach migrations_dir to only the first. Fail closed on duplicates.
    const matchIndices: Array<number> = [];
    d1Entries.forEach((entry, i) => {
      if (entry.binding === patch.d1MigrationsDir!.binding) {
        matchIndices.push(i);
      }
    });
    if (matchIndices.length > 1) {
      throw new Error(
        `deploy: cannot update "${configPath}" — binding ` +
          `${JSON.stringify(patch.d1MigrationsDir.binding)} is declared ${matchIndices.length} times ` +
          `in "d1_databases". A binding name must be unique across the worker (wrangler rejects the ` +
          `config otherwise), so migrations_dir cannot be attached unambiguously. Remove the ` +
          `duplicate D1 entry and retry.`,
      );
    }
    const index = matchIndices.length === 1 ? matchIndices[0] : -1;
    if (index >= 0) {
      // When this patch manages the D1 migrations dir, a DEFINED
      // non-string `migrations_pattern` (object/array/number/null) is rejected BEFORE
      // any keep-equivalent/fill branch runs. Wrangler's `resolveMigrationsConfig`
      // treats the pattern as a string, so committing `migrations_dir` beside a
      // malformed pattern would report provisioning success on a config that later
      // `wrangler d1 migrations` commands reject. Fail closed; the file stays
      // byte-identical (the write happens only after every gate passes).
      const existingPattern = d1Entries[index].migrations_pattern;
      if (existingPattern !== undefined && typeof existingPattern !== 'string') {
        throw new Error(
          `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
            `${JSON.stringify(patch.d1MigrationsDir.binding)} has a non-string ` +
            `"migrations_pattern" value; expected a string. Wrangler rejects such a config, so ` +
            `filling "migrations_dir" beside it would commit an invalid file. Fix the config ` +
            `and retry.`,
        );
      }
      // Fill-if-absent / keep-equivalent /
      // fail-closed-on-differ. `migrations_dir` is USER-OWNED once set — a reused D1
      // configured with e.g. `./legacy-migrations` must never be silently rewritten to
      // Void's default, which would strand the user's migration files.
      const existingDir = d1Entries[index].migrations_dir;
      if (existingDir !== undefined && typeof existingDir !== 'string') {
        // Malformed (object/array/number/…) — wrangler expects a string. Fail closed
        // without writing (matches the writer's composite-scalar philosophy).
        throw new Error(
          `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
            `${JSON.stringify(patch.d1MigrationsDir.binding)} has a non-string ` +
            `"migrations_dir" value; expected a string. Fix the config and retry.`,
        );
      }
      if (typeof existingDir === 'string') {
        if (
          normalizeMigrationsPath(existingDir) !==
          normalizeMigrationsPath(patch.d1MigrationsDir.dir)
        ) {
          // An explicit DIFFERENT directory — fail closed with both paths named.
          throw new Error(
            `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
              `${JSON.stringify(patch.d1MigrationsDir.binding)} already sets "migrations_dir": ` +
              `${JSON.stringify(existingDir)}, but Void keeps this database's migrations in ` +
              `${JSON.stringify(patch.d1MigrationsDir.dir)}. Refusing to overwrite an explicit ` +
              `different migrations directory. Either remove "migrations_dir" from the entry (or ` +
              `set it to ${JSON.stringify(patch.d1MigrationsDir.dir)}) to let Void manage it, or ` +
              `move the migrations and keep your directory, then retry.`,
          );
        }
        // keep-equivalent: `db/migrations` vs `./db/migrations` vs a trailing slash all
        // normalize equal (wrangler's own `normalizeRelativePath` rule) — leave the user's
        // spelling untouched so the file stays byte-identical.
      } else {
        // Absent → fill. A companion `migrations_pattern` (if the user set one) must stay
        // valid under the dir being written: wrangler requires the normalized pattern to
        // start with `${migrations_dir}/` (unless the dir normalizes to "."), so filling
        // the dir under an incompatible pattern would break `wrangler d1 migrations`.
        // Validate before editing; fail closed and NEVER rewrite the user-owned pattern.
        // (A defined pattern is narrowed to a STRING by the gate above.)
        if (
          existingPattern !== undefined &&
          !migrationsPatternMatchesDir(existingPattern, patch.d1MigrationsDir.dir)
        ) {
          throw new Error(
            `deploy: cannot update "${configPath}" — the D1 entry for binding ` +
              `${JSON.stringify(patch.d1MigrationsDir.binding)} has "migrations_pattern": ` +
              `${JSON.stringify(existingPattern)}, which is not under the requested ` +
              `"migrations_dir": ${JSON.stringify(patch.d1MigrationsDir.dir)}. Wrangler requires the ` +
              `pattern to start with the migrations dir, so this change would break ` +
              `\`wrangler d1 migrations\`. Align "migrations_pattern" with the dir (or remove it) and retry.`,
          );
        }
        set(['d1_databases', index, 'migrations_dir'], patch.d1MigrationsDir.dir);
      }
    } else {
      d1MigrationsDirSkipped = true;
    }
  }

  // queues — idempotent upsert into `queues.producers[]` / `queues.consumers[]`.
  // Each section keys on its wrangler identity:
  //   - PRODUCERS key on `binding`. wrangler requires producer binding names to
  //     be unique across the worker (multiple producers may target one queue),
  //     so the binding — not the queue — is the identity. Void's binding is the
  //     deterministic `QUEUE_<NAME>` (see `queues/scan.ts` + `runtime/queues.ts`).
  //     A missing binding is appended (a user's own same-queue producer with a
  //     different binding is left alone — Void must not hijack it); a binding
  //     already bound to a DIFFERENT queue fails closed.
  //   - CONSUMERS key on `queue`. wrangler allows exactly one consumer per queue,
  //     so the queue name is the identity.
  // Framework self-host only (see the note on ProvisionedWranglerPatch); a native
  // app would duplicate the build's scanner queues.
  const reconcileManagedQueues = patch.queues?.reconcileVoidOwned === true;
  const managedQueueProvenance = readManagedQueueProvenance(text);
  const managedProducerBindings = new Set(managedQueueProvenance.producerBindings);
  const managedConsumerQueues = new Set(managedQueueProvenance.consumerQueues);
  const pendingConsumerRemovals = new Set(managedQueueProvenance.pendingConsumerRemovals);
  const upsertQueueEntries = (
    section: 'producers' | 'consumers',
    entries: Array<Record<string, unknown>> | undefined,
  ): void => {
    if (!entries || entries.length === 0) {
      return;
    }
    // Re-parse `text` (not the initial `parsed`) so earlier edits in this call
    // are reflected; track appends locally to keep indices valid.
    const currentQueues = assertObjectContainer(parseJsonc(text).queues, 'queues');
    // Before mutating producers, route the EXISTING `queues.producers` list
    // through the SAME strict validator the adopt guard uses. Without this, a corrupt
    // list (e.g. `[null]`) would be cloned, its non-record members silently skipped by
    // the match loop below, and a new producer committed beside the corruption.
    if (section === 'producers') {
      assertValidQueueProducers(currentQueues?.producers);
    }
    const currentList = Array.isArray(currentQueues?.[section])
      ? [...(currentQueues[section] as Array<Record<string, unknown>>)]
      : [];
    for (const entry of entries) {
      // Match on the section's identity: producers by `binding`, consumers by
      // `queue`. Keying producers on the queue would rewrite the FIRST of several
      // legal same-queue producers, so a `{queue,CUSTOM}` + `{queue,QUEUE_JOBS}`
      // pair collapses into two identical `QUEUE_JOBS` bindings — a config
      // wrangler rejects.
      //
      // A producer `binding` must map to exactly ONE queue, so the fail-closed
      // guard must inspect EVERY producer sharing the desired binding — not just
      // the first `findIndex` hit — to stay deterministic regardless of array
      // order:
      //   - 0 matches                → append the new producer (`index = -1`).
      //   - 1 match, same queue      → no-op upsert (idempotent).
      //   - 1 match, different queue → fail closed (binding bound elsewhere).
      //   - >1 match (duplicate binding across entries) → fail closed; the
      //     registry is already undeployable, so never silently "converge" on it
      //     (an order-dependent first-match check would falsely report success).
      let index: number;
      if (section === 'producers') {
        const matches: Array<number> = [];
        for (let i = 0; i < currentList.length; i++) {
          const existing = currentList[i];
          if (isRecord(existing) && existing.binding === entry.binding) {
            matches.push(i);
          }
        }
        if (matches.length > 1) {
          throw new Error(
            `deploy: cannot update "${configPath}" — queue producer binding ` +
              `${JSON.stringify(entry.binding)} is declared ${matches.length} times across ` +
              `producers. A producer binding must map to exactly one queue, so wrangler rejects ` +
              `this config. Remove the duplicate producers and retry.`,
          );
        }
        if (matches.length === 1) {
          const existing = currentList[matches[0]];
          if (isRecord(existing) && existing.queue !== entry.queue) {
            throw new Error(
              `deploy: cannot update "${configPath}" — queue producer binding ` +
                `${JSON.stringify(entry.binding)} is already bound to queue ` +
                `${JSON.stringify(existing.queue)}, but queue ${JSON.stringify(entry.queue)} also ` +
                `requests it. A producer binding must map to exactly one queue. Rename or remove ` +
                `the conflicting producer and retry.`,
            );
          }
        }
        index = matches.length === 1 ? matches[0] : -1;
        // Run the canonical worker-wide binding-name collision check for EVERY
        // producer upsert (matched/idempotent AND append), not only the `index === -1`
        // append path. wrangler requires every binding NAME to be unique across the
        // ENTIRE worker — not just within `queues.producers` — so a producer binding
        // (`QUEUE_<NAME>`) that ALSO names any OTHER binding (D1/KV/R2/DO/service/var/
        // secret/AI/hyperdrive/vectorize/…) is a cross-type collision wrangler rejects
        // at deploy. That config is undeployable whether we APPEND the producer or leave
        // a same-queue one already in place, so BOTH must fail closed: skipping the
        // check on the idempotent path would silently accept an already-broken config
        // with `modified:false`, and would also miss a malformed OTHER binding field the
        // collector fails closed on. The collector deliberately OMITS `queues` (see
        // FRIENDLY_BINDING_NAMES), so a producer never self-collides. Build from the
        // CURRENT text so an adopt appended earlier in this call is seen too (not the
        // stale initial `parsed`).
        workerBindingOwners ??= collectWorkerBindingNames(parseJsonc(text));
        const bindingName = String(entry.binding);
        const owner = workerBindingOwners.get(bindingName);
        if (owner !== undefined) {
          throw new Error(
            `deploy: cannot update "${configPath}" — queue producer binding ` +
              `${JSON.stringify(bindingName)} is already used by a ${owner} binding. Wrangler ` +
              `requires every binding name to be unique across the whole worker, so this producer ` +
              `would make the config undeployable. Rename the conflicting binding (or the queue) ` +
              `and retry.`,
          );
        }
      } else {
        index = currentList.findIndex(
          (existing) => isRecord(existing) && existing.queue === entry.queue,
        );
      }

      if (index >= 0) {
        // Update ONLY the properties this patch supplies — never replace the
        // whole array element. A whole-object `modify()` at the element index
        // would drop inline comments AND any sibling fields the narrower
        // inferred patch omits (producer `delivery_delay`; consumer
        // `dead_letter_queue`, `max_concurrency`, …), silently changing
        // production delivery/retry/concurrency/failure-routing. Per-property
        // edits preserve unmentioned fields and comments, and stay idempotent
        // (a re-run finds each value already equal and writes nothing). For a
        // producer matched by binding the queue already equals (a mismatch threw
        // above), so this loop is a no-op that preserves the user's entry.
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
        // Append at `currentList.length`; `applyMemberEdit` also creates the
        // `queues` object and the section array when they don't exist yet, and
        // keeps a trailing inline comment attached to the preceding entry it
        // documented (see the comment-relocation logic there).
        text = applyMemberEdit(text, ['queues', section, currentList.length], entry, {
          formattingOptions,
          isArrayInsertion: true,
        });
        currentList.push(entry);
        if (reconcileManagedQueues) {
          if (section === 'producers' && typeof entry.binding === 'string') {
            managedProducerBindings.add(entry.binding);
          } else if (section === 'consumers' && typeof entry.queue === 'string') {
            managedConsumerQueues.add(entry.queue);
          }
        }
      }
    }
  };
  if (patch.queues) {
    if (patch.queues.reconcileVoidOwned) {
      const queues = assertObjectContainer(parseJsonc(text).queues, 'queues');
      assertValidQueueProducers(queues?.producers);
      const producers = Array.isArray(queues?.producers)
        ? (queues.producers as Array<Record<string, unknown>>)
        : [];
      const desiredBindings = new Set(
        (patch.queues.producers ?? []).map((producer) => producer.binding),
      );
      const staleProducerIndexes: Array<number> = [];
      for (let index = 0; index < producers.length; index++) {
        const producer = producers[index];
        if (
          typeof producer.binding === 'string' &&
          managedProducerBindings.has(producer.binding) &&
          !desiredBindings.has(producer.binding)
        ) {
          staleProducerIndexes.push(index);
          managedProducerBindings.delete(producer.binding);
        }
      }
      for (const index of staleProducerIndexes.reverse()) {
        set(['queues', 'producers', index], undefined);
      }

      const consumers = Array.isArray(queues?.consumers)
        ? (queues.consumers as Array<Record<string, unknown>>)
        : [];
      const desiredConsumerQueues = new Set(
        (patch.queues.consumers ?? []).map((consumer) => consumer.queue),
      );
      const staleConsumerIndexes = consumers.flatMap((consumer, index) => {
        if (
          typeof consumer.queue === 'string' &&
          managedConsumerQueues.has(consumer.queue) &&
          !desiredConsumerQueues.has(consumer.queue)
        ) {
          managedConsumerQueues.delete(consumer.queue);
          pendingConsumerRemovals.add(consumer.queue);
          return [index];
        }
        return [];
      });
      for (const index of staleConsumerIndexes.reverse()) {
        set(['queues', 'consumers', index], undefined);
      }
    }
    upsertQueueEntries('producers', patch.queues.producers);
    upsertQueueEntries('consumers', patch.queues.consumers);
    for (const consumer of patch.queues.consumers ?? []) {
      pendingConsumerRemovals.delete(consumer.queue);
    }
  }

  // vars — per-key upsert into the top-level `vars` object (created when absent).
  // Only the keys this patch names are written, and only when their value differs,
  // so sibling vars and their comments stay byte-identical. A var name is a worker
  // binding name too (wrangler folds `vars` into `validateBindingsHaveUniqueNames`),
  // so a key already held by ANOTHER binding type fails closed like the adopt path.
  if (patch.vars) {
    const currentConfig = parseJsonc(text);
    // Validates the outer shape: a present-but-non-object `vars` throws (fail closed)
    // rather than being replaced wholesale.
    bindingNamesForField('vars', currentConfig.vars);
    const currentVars = isRecord(currentConfig.vars) ? currentConfig.vars : {};
    const owners = collectWorkerBindingNames(configWithoutField(currentConfig, 'vars'));
    addQueueProducerOwners(owners, currentConfig);
    for (const [key, value] of Object.entries(patch.vars)) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `deploy: cannot update "${configPath}" — cannot write var ${JSON.stringify(key)} because ` +
            `that binding name is already used by a ${owner} binding. Wrangler requires every ` +
            `binding name to be unique across the whole worker, so this would make the config ` +
            `undeployable. Rename the conflicting binding and retry.`,
        );
      }
      if (!jsonEqual(currentVars[key], value)) {
        set(['vars', key], value);
      }
    }
  }

  // addresses — Void owns the WHOLE top-level array in Mode B, so a `string[]`
  // replaces the value outright (skipped when already equal, so a re-run is
  // byte-identical) and `null` removes the key. Neither goes through `set()`:
  // the array is composite by design, so the final gate's "expected a string"
  // diagnosis would be wrong for it — a comment nested inside a user-edited
  // `addresses` still trips the generic drop check below and fails closed.
  if (patch.addresses !== undefined) {
    const currentAddresses = parseJsonc(text).addresses;
    if (patch.addresses === null) {
      text = removeMember(text, ['addresses'], { formattingOptions });
    } else if (!jsonEqual(currentAddresses, patch.addresses)) {
      text = applyMemberEdit(text, ['addresses'], patch.addresses, { formattingOptions });
    }
  }

  // FINAL GATE — global comment-text-preservation invariant. The writer's
  // contract is that every comment's TEXT survives a write. Relocation only
  // MOVES a comment (identical text, new position), so the multiset of comment
  // TOKENS is preserved and this gate passes. A DROPPED comment — the
  // composite-overwrite case above, or any other pathological path — makes the
  // output multiset miss a token. Assert the final output is a SUPERSET of the
  // original's comment tokens BEFORE writing; on any drop, throw WITHOUT writing
  // so the file is never corrupted (the BOM re-add + write happen only past this
  // gate). O(n): one scanner pass over each string.
  const droppedComment = findDroppedComment(
    extractCommentTokens(original),
    extractCommentTokens(text),
  );
  if (droppedComment !== undefined) {
    // Prefer a specific diagnosis when the cause is a scalar-expected field that
    // held a composite (object/array) value in the ORIGINAL — `modify()` would
    // have replaced the whole node, dropping the nested comment.
    const originalRoot = parseTree(original, undefined, { allowTrailingComma: true });
    const compositeField = originalRoot
      ? scalarSetPaths.find((path) => {
          const node = findNodeAtLocation(originalRoot, path);
          return node?.type === 'object' || node?.type === 'array';
        })
      : undefined;
    if (compositeField) {
      const field = String(compositeField[compositeField.length - 1]);
      throw new Error(
        `deploy: cannot update "${configPath}" — "${field}" has an object/array value; ` +
          `expected a string. Fix the config and retry.`,
      );
    }
    throw new Error(
      `deploy: cannot update "${configPath}" — this edit would drop a comment ` +
        `(${droppedComment}); the writer refuses to corrupt the file — simplify the ` +
        `surrounding structure and retry.`,
    );
  }

  if (reconcileManagedQueues) {
    const finalQueues = assertObjectContainer(parseJsonc(text).queues, 'queues');
    const finalProducerBindings = new Set(
      (Array.isArray(finalQueues?.producers) ? finalQueues.producers : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.binding === 'string' ? [entry.binding] : [],
      ),
    );
    const finalConsumerQueues = new Set(
      (Array.isArray(finalQueues?.consumers) ? finalQueues.consumers : []).flatMap((entry) =>
        isRecord(entry) && typeof entry.queue === 'string' ? [entry.queue] : [],
      ),
    );
    text = writeManagedQueueProvenance(text, {
      producerBindings: [...managedProducerBindings].filter((binding) =>
        finalProducerBindings.has(binding),
      ),
      consumerQueues: [...managedConsumerQueues].filter((queue) => finalConsumerQueues.has(queue)),
      pendingConsumerRemovals: [...pendingConsumerRemovals],
    });
  }

  const finalText = hasBom ? `${UTF8_BOM}${text}` : text;
  const modified = finalText !== rawContent;
  if (modified) {
    writeProjectWranglerFile(configPath, finalText);
  }
  return { configPath, modified, d1MigrationsDirSkipped };
}

/** Read the custom-domain routes owned by the root Wrangler config. */
export function readWranglerCustomDomains(root: string): WranglerCustomDomainUpdate {
  const configPath = discoverWranglerConfigPath(root);
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
  const text = raw.startsWith(UTF8_BOM) ? raw.slice(UTF8_BOM.length) : raw;
  const parsed = parseJsonc(text);
  assertNoDuplicateMembers(text, configPath);
  return {
    configPath,
    domains: parseCustomDomains(parsed.routes, configPath),
    modified: false,
  };
}

/**
 * Add or remove one Wrangler `custom_domain` route without rewriting unrelated
 * configuration. The returned domain list is the post-edit source of truth used
 * by `void domain list|status` on direct Cloudflare projects.
 */
export function updateWranglerCustomDomain(
  root: string,
  hostname: string,
  action: 'add' | 'delete',
): WranglerCustomDomainUpdate {
  const configPath = discoverWranglerConfigPath(root);
  if (!existsSync(configPath)) {
    throw new Error(
      `domain: No Wrangler config found at "${configPath}". Run \`void init\` first.`,
    );
  }
  const raw = readFileSync(configPath, 'utf-8');
  const hasBom = raw.startsWith(UTF8_BOM);
  const original = hasBom ? raw.slice(UTF8_BOM.length) : raw;
  const parsed = parseJsonc(original);
  assertNoDuplicateMembers(original, configPath);
  if (parsed.route !== undefined) {
    throw new Error(
      `domain: "${configPath}" uses the singular "route" field. Convert it to a "routes" array before managing custom domains so the existing route cannot be shadowed.`,
    );
  }
  const routes = parsed.routes;
  if (routes !== undefined && !Array.isArray(routes)) {
    throw new Error(`domain: "routes" in "${configPath}" must be an array.`);
  }
  const routeArray = (routes ?? []) as Array<unknown>;
  const matches: Array<number> = [];
  for (let index = 0; index < routeArray.length; index++) {
    const route = routeArray[index];
    if (typeof route === 'string') {
      if (route === hostname) {
        throw new Error(
          `domain: ${JSON.stringify(hostname)} already exists as a non-custom route in "${configPath}". Remove or convert that route first.`,
        );
      }
      continue;
    }
    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
      throw new Error(`domain: "routes[${index}]" in "${configPath}" is malformed.`);
    }
    const entry = route as Record<string, unknown>;
    if (entry.pattern !== hostname) {
      continue;
    }
    if (entry.custom_domain !== true) {
      throw new Error(
        `domain: ${JSON.stringify(hostname)} already exists as a non-custom route in "${configPath}". Remove or convert that route first.`,
      );
    }
    matches.push(index);
  }
  if (matches.length > 1) {
    throw new Error(
      `domain: ${JSON.stringify(hostname)} is declared more than once in "${configPath}". Remove the duplicate before continuing.`,
    );
  }

  let text = original;
  const formattingOptions = detectFormattingOptions(original);
  if (action === 'add' && matches.length === 0) {
    text = applyMemberEdit(
      text,
      ['routes', routeArray.length],
      { pattern: hostname, custom_domain: true },
      { formattingOptions, isArrayInsertion: true },
    );
    const dropped = findDroppedComment(extractCommentTokens(original), extractCommentTokens(text));
    if (dropped !== undefined) {
      throw new Error(
        `domain: cannot update "${configPath}" because the edit would drop a comment (${dropped}).`,
      );
    }
  } else if (action === 'delete' && matches.length === 1) {
    text = applyEdits(text, modify(text, ['routes', matches[0]], undefined, { formattingOptions }));
  }

  const finalText = hasBom ? `${UTF8_BOM}${text}` : text;
  const modified = finalText !== raw;
  if (modified) {
    writeProjectWranglerFile(configPath, finalText);
  }
  return {
    configPath,
    domains: parseCustomDomains(parseJsonc(text).routes, configPath),
    modified,
  };
}

function discoverWranglerConfigPath(root: string): string {
  for (const path of projectWranglerPaths(root)) {
    if (existsSync(path)) {
      return path;
    }
  }
  return materializeCloudflareConfig(root);
}

function parseCustomDomains(value: unknown, configPath: string): Array<WranglerCustomDomain> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`domain: "routes" in "${configPath}" must be an array.`);
  }
  const domains: Array<WranglerCustomDomain> = [];
  for (let index = 0; index < value.length; index++) {
    const route = value[index];
    if (typeof route === 'string') {
      continue;
    }
    if (typeof route !== 'object' || route === null || Array.isArray(route)) {
      throw new Error(`domain: "routes[${index}]" in "${configPath}" is malformed.`);
    }
    const entry = route as Record<string, unknown>;
    if (entry.custom_domain !== true) {
      continue;
    }
    if (typeof entry.pattern !== 'string' || entry.pattern.length === 0) {
      throw new Error(
        `domain: custom domain route "routes[${index}]" in "${configPath}" needs a non-empty pattern.`,
      );
    }
    domains.push({ pattern: entry.pattern, customDomain: true });
  }
  return domains;
}

/**
 * Extract the multiset of comment TOKENS (line + block) from JSONC source using
 * jsonc-parser's scanner — exact by construction, no regex. Each token is its
 * verbatim source slice, so a relocated comment keeps identical text (its
 * multiset entry is unchanged) while a dropped comment removes one.
 */
function extractCommentTokens(text: string): Array<string> {
  const scanner = createScanner(text, false);
  const tokens: Array<string> = [];
  let kind = scanner.scan();
  while (kind !== SyntaxKind.EOF) {
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      tokens.push(text.slice(offset, offset + scanner.getTokenLength()));
    }
    kind = scanner.scan();
  }
  return tokens;
}

/**
 * Multiset-subset check: return the first comment token present in `before` but
 * missing (accounting for repeats) from `after`, or `undefined` when `after` is
 * a superset of `before`. The final gate uses this to prove no comment TEXT was
 * dropped by the edits.
 */
function findDroppedComment(before: Array<string>, after: Array<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const token of after) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of before) {
    const remaining = counts.get(token) ?? 0;
    if (remaining <= 0) {
      return token;
    }
    counts.set(token, remaining - 1);
  }
  return undefined;
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
 * `modify()` + `applyEdits()`, but when the edit APPENDS a new member after a
 * sibling that carries a trailing inline comment, keep that comment attached to
 * the sibling it documented.
 *
 * jsonc-parser's formatting `modify()` reflows the whole enclosing member/entry
 * region and re-emits a trailing inline comment at the END of that region — so
 * inserting `migrations_dir` after `"database_id": "id" // production db` (or
 * appending a queue entry after `{ … } // jobs producer`) silently reassociates
 * the comment onto the NEWLY inserted member. That violates the writer's
 * comment-preservation contract. Here we detect that exact case, run the
 * (comment-free) formatting edit on a stripped copy, then splice the comment
 * back right after the sibling's separating comma so it stays put.
 *
 * Every other edit (value replacement, append after a comment-free sibling,
 * first insertion into a missing container) falls through to the plain path, so
 * behavior is byte-identical to before outside the trailing-comment case.
 */
function applyMemberEdit(
  text: string,
  path: Array<string | number>,
  value: unknown,
  options: { formattingOptions: FormattingOptions; isArrayInsertion?: boolean },
): string {
  const plain = (): string => applyEdits(text, modify(text, path, value, options));

  const root = parseTree(text, undefined, { allowTrailingComma: true });
  if (!root) {
    return plain();
  }

  // Only an APPEND can split a sibling from its trailing comment. A value
  // replacement (existing object key, not an array insertion) reformats just
  // that member and keeps its own comment — nothing to relocate.
  if (!options.isArrayInsertion && findNodeAtLocation(root, path) !== undefined) {
    return plain();
  }

  // Find the container `modify()` will append the new member to. Usually the
  // leaf container (`path` minus its final key/index). But when that container
  // does not exist yet, `modify()` creates the first missing segment as a NEW
  // member of the deepest ANCESTOR that DOES exist — so that ancestor is the
  // receiver, and its current last member is the preceding sibling whose
  // trailing comment must stay put (e.g. adding `queues.producers` next to a
  // `queues.consumers` that carries a `// …` trailing comment). Anchoring the
  // relocation on the real receiving container keeps the comment on the sibling
  // in both cases.
  let receivingPath = path.slice(0, -1);
  let container = findNodeAtLocation(root, receivingPath);
  while (!container && receivingPath.length > 0) {
    receivingPath = receivingPath.slice(0, -1);
    container = findNodeAtLocation(root, receivingPath);
  }
  const members = container?.children;
  if (!container || !members || members.length === 0) {
    return plain();
  }

  // jsonc-parser appends both new object properties and new array elements after
  // the container's current last member, so that member is the preceding sibling.
  const last = members[members.length - 1];
  const trailing = readTrailingComment(text, last.offset + last.length);
  if (!trailing) {
    return plain();
  }

  // Strip the comment (and the optional separator comma `readTrailingComment`
  // skipped to reach it), run the now-comment-free formatting edit, then
  // re-attach the comment after the sibling's separating comma in the rewritten
  // text.
  const stripped = text.slice(0, last.offset + last.length) + text.slice(trailing.end);
  const rewritten = applyEdits(stripped, modify(stripped, path, value, options));

  const newRoot = parseTree(rewritten, undefined, { allowTrailingComma: true });
  const newContainer = newRoot ? findNodeAtLocation(newRoot, receivingPath) : undefined;
  const newMembers = newContainer?.children;
  if (!newRoot || !newContainer || !newMembers || newMembers.length < 2) {
    // We just appended, so this should not happen; fall back rather than corrupt.
    return plain();
  }
  // The appended member is last; its predecessor is the sibling we relocate onto.
  const sibling = newMembers[newMembers.length - 2];
  const commaPos = rewritten.indexOf(',', sibling.offset + sibling.length);
  if (commaPos === -1) {
    return plain();
  }
  const relocated = `${rewritten.slice(0, commaPos + 1)} ${trailing.text}${rewritten.slice(commaPos + 1)}`;

  // Validate-before-write backstop. Comment relocation must ONLY ever change
  // comment placement — never JSONC validity or data. Re-parse the relocated
  // string; if it does not parse, or its data is not deeply equal to the plain
  // formatting edit's data, discard it and return the plain (always-valid)
  // result. This makes relocation safe by construction: the worst case is a
  // comment reassociated by jsonc-parser onto the wrong sibling, but the file is
  // always valid JSONC and always carries the correct data — never corruption.
  const plainResult = plain();
  let relocatedParsed: Record<string, unknown>;
  try {
    relocatedParsed = parseJsonc(relocated);
  } catch {
    return plainResult;
  }
  if (!jsonEqual(relocatedParsed, parseJsonc(plainResult))) {
    return plainResult;
  }
  return relocated;
}

/**
 * Remove one object member (the property at `path`), keeping every comment.
 *
 * jsonc-parser's `modify(text, path, undefined)` deletes from the END of the
 * previous member to the end of the removed one — so the previous sibling's
 * trailing comment, a full-line comment above the member, and the member's own
 * trailing comment all vanish (measured on 4.x). The final comment gate would
 * then refuse the write for the common `"name": "app", // worker` shape. Here
 * the property node's exact source range is spliced out instead, plus ONE
 * separating comma (the following one when present, else the preceding one so
 * a strict `.json` file never gains a trailing comma) and the now-blank line it
 * sat on. Comments are never inside those ranges, so they all stay put; a
 * comment that was attached to the removed member is left orphaned on its line.
 *
 * Validate-before-return backstop: the spliced text must parse and equal the
 * plain `modify()` result's data; otherwise the plain edit is returned and the
 * final gate decides. An absent member is a no-op.
 */
function removeMember(
  text: string,
  path: Array<string | number>,
  options: { formattingOptions: FormattingOptions },
): string {
  const root = parseTree(text, undefined, { allowTrailingComma: true });
  const valueNode = root ? findNodeAtLocation(root, path) : undefined;
  const property = valueNode?.parent;
  if (!root || !valueNode || !property || property.type !== 'property') {
    return valueNode ? applyEdits(text, modify(text, path, undefined, options)) : text;
  }
  const start = property.offset;
  const end = property.offset + property.length;

  // Tokenize once so comments and whitespace are skipped by KIND, never by regex.
  const scanner = createScanner(text, false);
  const tokens: Array<{ kind: SyntaxKind; offset: number; length: number }> = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    tokens.push({ kind, offset: scanner.getTokenOffset(), length: scanner.getTokenLength() });
  }
  const isTrivia = (kind: SyntaxKind): boolean =>
    kind === SyntaxKind.Trivia ||
    kind === SyntaxKind.LineBreakTrivia ||
    kind === SyntaxKind.LineCommentTrivia ||
    kind === SyntaxKind.BlockCommentTrivia;
  const following = tokens.find((token) => token.offset >= end && !isTrivia(token.kind));
  const preceding = [...tokens]
    .reverse()
    .find((token) => token.offset + token.length <= start && !isTrivia(token.kind));
  const comma =
    following?.kind === SyntaxKind.CommaToken
      ? following
      : preceding?.kind === SyntaxKind.CommaToken
        ? preceding
        : undefined;

  // Splice the higher range first so the lower offsets stay valid.
  const ranges = [{ offset: start, length: end - start }];
  if (comma) {
    ranges.push({ offset: comma.offset, length: comma.length });
  }
  ranges.sort((a, b) => b.offset - a.offset);
  let spliced = text;
  for (const range of ranges) {
    spliced = spliced.slice(0, range.offset) + spliced.slice(range.offset + range.length);
  }

  // Drop the line the member sat on when nothing but whitespace is left of it
  // (its trailing comment, if any, keeps the line alive). Handles LF, CRLF and
  // CR-only endings. `cursor` is the member's start in the spliced text — shifted
  // left when the removed comma sat before it.
  const cursor = comma && comma.offset < start ? start - comma.length : start;
  let lineStart = cursor;
  while (lineStart > 0 && spliced[lineStart - 1] !== '\n' && spliced[lineStart - 1] !== '\r') {
    lineStart--;
  }
  let lineEnd = cursor;
  while (lineEnd < spliced.length && spliced[lineEnd] !== '\n' && spliced[lineEnd] !== '\r') {
    lineEnd++;
  }
  if (spliced.slice(lineStart, lineEnd).trim() === '') {
    const terminator = spliced.startsWith('\r\n', lineEnd) ? 2 : lineEnd < spliced.length ? 1 : 0;
    spliced = spliced.slice(0, lineStart) + spliced.slice(lineEnd + terminator);
  }

  const plainResult = applyEdits(text, modify(text, path, undefined, options));
  let splicedParsed: Record<string, unknown>;
  try {
    splicedParsed = parseJsonc(spliced);
  } catch {
    return plainResult;
  }
  if (!jsonEqual(splicedParsed, parseJsonc(plainResult))) {
    return plainResult;
  }
  return spliced;
}

/**
 * If a trailing inline comment sits on the same line right after `offset`,
 * return its text and end offset. Only whitespace and an OPTIONAL single
 * separator comma may sit between the sibling's value and the comment — so both
 * `"id": "x" // c` and `"id": "x", // c` (a JSONC trailing comma, or the
 * separator once a sibling follows) are recognized. A `//` line comment or a
 * single-line `/* *\/` block comment counts; a newline or closing bracket first
 * means there is no trailing comment (returns undefined). `offset` points just
 * past the sibling's value, and the sibling is always its container's LAST
 * member, so any comma here is a trailing/separator comma — never a boundary to
 * an existing following member.
 */
function readTrailingComment(
  text: string,
  offset: number,
): { text: string; end: number } | undefined {
  let i = offset;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  // Tolerate one optional separator/trailing comma between the value and its
  // inline comment. `stripped` (at the call site) removes everything from
  // `offset` through the comment's end, so the skipped comma is discarded and
  // the re-attach step re-inserts the comment after the sibling's fresh comma.
  if (text[i] === ',') {
    i++;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
      i++;
    }
  }
  if (text[i] === '/' && text[i + 1] === '/') {
    // A line comment ends at the first line terminator — CR or LF. Stopping at
    // BOTH means a classic-Mac CR-only file terminates the comment here instead
    // of swallowing the rest of the line (including the closing brace, which
    // would relocate the new member outside the root object and corrupt the
    // file); and a CRLF file's trailing `\r` is left out of the comment text and
    // preserved on write.
    let end = i;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end++;
    }
    return { text: text.slice(i, end), end };
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const close = text.indexOf('*/', i + 2);
    if (close === -1) {
      return undefined;
    }
    const end = close + 2;
    // Only a single-line block comment is safe to relocate onto one line. A CR
    // or LF inside makes it multi-line → decline (accepted best-effort path).
    const slice = text.slice(i, end);
    if (slice.includes('\n') || slice.includes('\r')) {
      return undefined;
    }
    return { text: slice, end };
  }
  return undefined;
}

/**
 * Throw (without writing) if any object in the config declares the same member
 * name twice. See the call site for why a duplicate makes property-level upserts
 * silently ineffective. Walks the jsonc AST so nested objects (queue consumers,
 * D1 entries, …) are covered, not just the top level.
 */
export function assertNoDuplicateMembers(text: string, configPath: string): void {
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

function validateDurableObjectMigrations(
  value: unknown,
  configPath: string,
): Array<DurableObjectMigration> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot update "${configPath}" — "migrations" must be an array of Durable Object migration steps.`,
    );
  }
  const tags = new Set<string>();
  for (const [index, migration] of value.entries()) {
    if (!isRecord(migration) || typeof migration.tag !== 'string' || migration.tag.length === 0) {
      throw new Error(
        `deploy: cannot update "${configPath}" — migration at index ${index} must be an object with a non-empty string "tag".`,
      );
    }
    if (tags.has(migration.tag)) {
      throw new Error(
        `deploy: cannot update "${configPath}" — migration tag '${migration.tag}' is declared more than once.`,
      );
    }
    tags.add(migration.tag);
    for (const field of ['new_classes', 'new_sqlite_classes', 'deleted_classes'] as const) {
      const classes = migration[field];
      if (
        classes !== undefined &&
        (!Array.isArray(classes) || classes.some((className) => typeof className !== 'string'))
      ) {
        throw new Error(
          `deploy: cannot update "${configPath}" — "migrations[${index}].${field}" must be an array of class names.`,
        );
      }
    }
    const renamed = migration.renamed_classes;
    if (
      renamed !== undefined &&
      (!Array.isArray(renamed) ||
        renamed.some(
          (entry) =>
            !isRecord(entry) || typeof entry.from !== 'string' || typeof entry.to !== 'string',
        ))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "migrations[${index}].renamed_classes" has an invalid entry.`,
      );
    }
    const transferred = migration.transferred_classes;
    if (
      transferred !== undefined &&
      (!Array.isArray(transferred) ||
        transferred.some(
          (entry) =>
            !isRecord(entry) ||
            typeof entry.from !== 'string' ||
            typeof entry.from_script !== 'string' ||
            typeof entry.to !== 'string',
        ))
    ) {
      throw new Error(
        `deploy: cannot update "${configPath}" — "migrations[${index}].transferred_classes" has an invalid entry.`,
      );
    }
  }
  return value as Array<DurableObjectMigration>;
}

/**
 * wrangler's friendly label for each binding namespace. Mirrors
 * `friendlyBindingNames` in `wrangler-dist/cli.js` — the map
 * `validateBindingsHaveUniqueNames` iterates to gather every worker-wide binding
 * name. Drives the owner name in the worker-wide producer-collision error.
 *
 * This is a 1:1 copy of wrangler's `friendlyBindingNames` EXCEPT `queues`, which
 * is intentionally ABSENT: wrangler folds in `queues.producers`, but here producer
 * identity is handled by the upsert's own binding-match logic (and consumers carry
 * no binding), so including it would flag the very producer we are about to append
 * as a self-collision. Every OTHER field wrangler enumerates is present (including
 * `unsafe_hello_world`). `secrets.required` — which wrangler folds in separately
 * under the label "Secret", not via this map — is handled in
 * `collectWorkerBindingNames`.
 */
export const FRIENDLY_BINDING_NAMES: Record<string, string> = {
  data_blobs: 'Data Blob',
  durable_objects: 'Durable Object',
  kv_namespaces: 'KV Namespace',
  send_email: 'Send Email',
  d1_databases: 'D1 Database',
  vectorize: 'Vectorize Index',
  ai_search_namespaces: 'AI Search Namespace',
  ai_search: 'AI Search Instance',
  websearch: 'Web Search',
  agent_memory: 'Agent Memory',
  hyperdrive: 'Hyperdrive Config',
  r2_buckets: 'R2 Bucket',
  logfwdr: 'logfwdr',
  services: 'Worker',
  analytics_engine_datasets: 'Analytics Engine Dataset',
  text_blobs: 'Text Blob',
  browser: 'Browser Run',
  ai: 'AI',
  images: 'Images',
  stream: 'Stream',
  media: 'Media',
  version_metadata: 'Worker Version Metadata',
  unsafe: 'Unsafe Metadata',
  vars: 'Environment Variable',
  wasm_modules: 'Wasm Module',
  dispatch_namespaces: 'Dispatch Namespace',
  mtls_certificates: 'mTLS Certificate',
  workflows: 'Workflow',
  pipelines: 'Pipeline',
  secrets_store_secrets: 'Secrets Store Secret',
  artifacts: 'Artifacts',
  ratelimits: 'Rate Limit',
  assets: 'Assets',
  unsafe_hello_world: 'Hello World',
  flagship: 'Flagship',
  worker_loaders: 'Worker Loader',
  vpc_services: 'VPC Service',
  vpc_networks: 'VPC Network',
};

/**
 * Collect every binding NAME already used across the worker config, mapped to
 * wrangler's friendly owner label (first writer wins on ties). Mirrors the exact
 * name set `validateBindingsHaveUniqueNames` builds in `wrangler-dist/cli.js`:
 * `getBindingNames(config[field])` for every `friendlyBindingNames` field, PLUS
 * `config.secrets.required` under the label "Secret" — minus `queues` (see
 * FRIENDLY_BINDING_NAMES for why). Used to fail closed before appending a queue
 * producer whose binding collides with any other worker-wide binding.
 */
function collectWorkerBindingNames(config: Record<string, unknown>): Map<string, string> {
  const owners = new Map<string, string>();
  const claim = (name: string, friendly: string): void => {
    if (!owners.has(name)) {
      owners.set(name, friendly);
    }
  };
  for (const [field, friendly] of Object.entries(FRIENDLY_BINDING_NAMES)) {
    for (const name of bindingNamesForField(field, config[field])) {
      claim(name, friendly);
    }
  }
  // wrangler folds `secrets.required` into the uniqueness set OUTSIDE the
  // `friendlyBindingNames` loop, under the friendly label "Secret" (see
  // `validateBindingsHaveUniqueNames`:
  // `bindingsGroupedByType["Secret"] = config2.secrets?.required ?? []`). These
  // ARE worker binding names at deploy, so a queue producer must never silently
  // collide with one.
  const secrets = assertObjectContainer(config.secrets, 'secrets');
  if (secrets && secrets.required !== undefined) {
    // `secrets.required` is a string[] folded into wrangler's uniqueness set
    // under "Secret". Validate it STRICTLY: a non-array, or any non-empty-string
    // member, throws (fail closed) rather than being silently skipped, which would
    // let a queue producer collide with a real secret binding name unnoticed.
    if (!Array.isArray(secrets.required)) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "secrets.required" must be an array of ` +
          `secret names. Fix the wrangler config and retry.`,
      );
    }
    secrets.required.forEach((name, index) => {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(
          `deploy: cannot verify binding-name uniqueness — "secrets.required" contains a malformed ` +
            `entry at index ${index} (expected a non-empty string). Refusing to proceed on a ` +
            `partially-readable binding set (a dropped entry could hide a real collision). Fix the ` +
            `wrangler config and retry.`,
        );
      }
      claim(name, 'Secret');
    });
  }
  return owners;
}

/** A shallow copy of `config` with one field omitted (never mutates the input). */
function configWithoutField(
  config: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const { [field]: _omit, ...rest } = config;
  return rest;
}

/**
 * Add every `queues.producers[].binding` to an existing worker-binding owner map,
 * under the friendly label "Queue" (first-writer-wins). The base
 * `collectWorkerBindingNames` deliberately OMITS queues so the producer-append
 * path does not flag the producer it is adding as a self-collision — but for the
 * ADOPT path a producer binding sharing the adopted binding IS a real cross-type
 * collision wrangler rejects at deploy, so the adopt guard layers producers on
 * top of the reused collector.
 */
function addQueueProducerOwners(
  owners: Map<string, string>,
  config: Record<string, unknown>,
): void {
  const queues = assertObjectContainer(config.queues, 'queues');
  if (!queues || queues.producers === undefined) {
    return;
  }
  // Validate `queues.producers` STRICTLY (the ONE shared validator, also used
  // by the producer-upsert path) so a non-array or a malformed member fails closed
  // rather than being silently skipped, which would let the adopt guard miss a real
  // producer-binding collision.
  for (const producer of assertValidQueueProducers(queues.producers)) {
    const binding = producer.binding as string;
    if (!owners.has(binding)) {
      owners.set(binding, 'Queue');
    }
  }
}

/**
 * The ONE strict `queues.producers` validator, shared by BOTH the adopt-guard's
 * owner collection ({@link addQueueProducerOwners}) and the producer-upsert path (which
 * otherwise clones the list and silently skips non-record members, committing a new
 * producer beside a corrupt list). A non-array, or any member that is not a record with
 * a non-empty string `binding`, THROWS (fail closed) rather than being dropped — a
 * dropped/hidden producer could mask a real binding collision. Returns the validated
 * producer records (each guaranteed to carry a non-empty string `binding`).
 */
function assertValidQueueProducers(producers: unknown): Array<Record<string, unknown>> {
  if (producers === undefined) {
    return [];
  }
  if (!Array.isArray(producers)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "queues.producers" must be an array. Fix ` +
        `the wrangler config and retry.`,
    );
  }
  return producers.map((producer, index) => {
    if (
      !isRecord(producer) ||
      typeof producer.binding !== 'string' ||
      producer.binding.length === 0
    ) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "queues.producers" contains a malformed ` +
          `entry at index ${index} (missing a non-empty string "binding"). Refusing to proceed on a ` +
          `partially-readable binding set (a dropped producer could hide a real collision). Fix the ` +
          `wrangler config and retry.`,
      );
    }
    return producer;
  });
}

/**
 * Validate the OUTER shape of a wrangler container field that wrangler 4.131
 * requires to be an OBJECT (`queues`, `secrets`). A PRESENT-but-non-object container
 * (array/string/number/null) is malformed for wrangler AND would bypass the binding
 * collectors, HIDING a real cross-type binding collision — so it THROWS (fail closed).
 * An ABSENT container (undefined) returns undefined (a no-op, NOT an error).
 * Returns the container as a record when present-and-object.
 *
 * NOTE: `null` is `typeof 'object'` but `isRecord(null)` is false, so `secrets: null` /
 * `queues: null` (present but null) THROWS — correct (wrangler requires an object).
 * Absent (`undefined`) is the only no-op.
 */
function assertObjectContainer(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object. Refusing to ` +
        `proceed on a partially-readable binding set (a wrong-shaped container could hide a real ` +
        `collision). Fix the wrangler config and retry.`,
    );
  }
  return value;
}

/**
 * The worker-wide OWNER of a binding name as the writer's adopt / `vars` guards see it:
 * validates `field`'s own outer shape (throws on a malformed target, fail closed), then
 * looks `name` up among every OTHER binding type — `queues.producers` included — and
 * returns wrangler's friendly label for the owner, or `undefined` when the name is free
 * (or held only by `field` itself). Lets a caller refuse a doomed write BEFORE side
 * effects the write would otherwise follow (the Mode B email step). Reuses the ONE
 * collector — never fork it.
 */
export function findBindingNameOwner(
  config: Record<string, unknown>,
  field: string,
  name: string,
): string | undefined {
  bindingNamesForField(field, config[field]);
  const owners = collectWorkerBindingNames(configWithoutField(config, field));
  addQueueProducerOwners(owners, config);
  return owners.get(name);
}

/**
 * The STRICT canonical reader for a single provisioned binding entry in a wrangler
 * config field (`d1_databases` / `kv_namespaces` / `r2_buckets` / `hyperdrive`). Replaces
 * the provisioner's loose first-match `.find()` — which validated no outer shape,
 * silently picked among duplicates, and bypassed the worker-wide collision check, so a
 * duplicate/cross-type-collision config could be reported `reused` or pass a create
 * postcondition though it is undeployable. Fails closed on:
 *   1. a malformed TARGET field (reuses {@link bindingNamesForField}: a non-array outer
 *      shape, or any member without a non-empty string `binding`, throws);
 *   2. MORE THAN ONE entry in the target field sharing `binding` (ambiguous identity —
 *      wrangler also rejects duplicate binding names);
 *   3. a worker-wide CROSS-TYPE collision — `binding` is ALSO owned by any OTHER binding
 *      type (reuses the {@link collectWorkerBindingNames} Task-3 collector, EXCLUDING the
 *      target field so the entry never self-collides, and INCLUDING `queues.producers`).
 * Returns the single matching entry, or `undefined` when the binding is absent.
 */
export function readProvisionedBindingEntry(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  configPath: string,
): Record<string, unknown> | undefined {
  // 1. Outer-shape validation of the TARGET field (throws on a non-array / malformed
  //    member — a member without a valid `binding` could hide a duplicate/collision).
  bindingNamesForField(field, config[field]);
  // 2. EXACTLY zero-or-one entry in the target field carries this binding.
  const rawList = config[field];
  const list = Array.isArray(rawList) ? rawList : [];
  const matches = list.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.binding === binding,
  );
  if (matches.length > 1) {
    throw new Error(
      `provision: cannot read "${configPath}" — binding ${JSON.stringify(binding)} is declared ` +
        `${matches.length} times in "${field}". Cannot pick one to reuse/verify, and wrangler rejects ` +
        `duplicate binding names. Remove the duplicate and retry.`,
    );
  }
  // 3. Worker-wide CROSS-TYPE uniqueness — the binding must not be owned by any OTHER
  //    field. Build the owner map from the config EXCLUDING the target field (so the
  //    entry does not self-collide) and INCLUDING queues.producers. Reuse the ONE
  //    collector — never fork it.
  const owners = collectWorkerBindingNames(configWithoutField(config, field));
  addQueueProducerOwners(owners, config);
  const owner = owners.get(binding);
  if (owner !== undefined) {
    throw new Error(
      `provision: cannot read "${configPath}" — binding ${JSON.stringify(binding)} in "${field}" is ` +
        `also used by a ${owner} binding. Wrangler requires every binding name to be unique across ` +
        `the whole worker, so this config is undeployable. Rename the conflicting binding and retry.`,
    );
  }
  return matches[0];
}

/**
 * The OUTER binding-name SHAPE of a wrangler config field, so the collector reads
 * binding NAMES by KNOWN structure instead of GUESSING from a value's content (which
 * misreads a `vars` value that happens to look like a binding list/object, and lets a
 * required-but-missing binding pass). Each variant + its required-ness is derived
 * DIRECTLY from wrangler 4.131's config-schema.json (`RawConfig.properties`):
 *
 *   | shape            | schema example                         | binding name is | required        |
 *   | ---------------- | -------------------------------------- | --------------- | --------------- |
 *   | key-map          | vars/wasm_modules/text_blobs/data_blobs| the KEYS        | —               |
 *   | name-keyed-array | send_email/ratelimits `[{ name }]`     | member `.name`  | `.name` req     |
 *   | namespace-array  | kv_namespaces/d1_databases/… `[{ binding }]` | member `.binding` | `.binding` req |
 *   | singleton        | ai/browser/…/version_metadata `{ binding }`  | `.binding`   | req (assets: optional) |
 *   | binding-list     | durable_objects/logfwdr/unsafe `{ bindings: [{ name }] }` | member `.name` | `bindings` req (unsafe: optional) |
 *   | whole-object     | addresses `string[]`                   | none            | —               |
 *
 * `whole-object` is a top-level field Void WRITES (`writeProvisionedWranglerConfig`)
 * that is NOT a binding — it declares no name wrangler folds into
 * `validateBindingsHaveUniqueNames`, so it is absent from `FRIENDLY_BINDING_NAMES`
 * and contributes nothing here. `addresses` reconciles Email Routing rules on
 * `wrangler deploy` (≥ 4.113), so the deploy verifier pins it WHOLE against the
 * pre-build root (`DEPLOY_WHOLE_OBJECT_PINNED_FIELDS` in `deploy.ts`) instead of
 * per entry: a build that injects one redirects the account's inbound mail.
 *
 * `namespace-array` is the DEFAULT for every `FRIENDLY_BINDING_NAMES` field not listed
 * in {@link BINDING_FIELD_SHAPES}. `secrets.required` (a `string[]`) is folded in
 * separately by {@link collectWorkerBindingNames}, and `queues.producers` by
 * {@link addQueueProducerOwners} / the producer-upsert path — neither uses this table.
 */
type BindingFieldShape =
  | { kind: 'key-map' }
  | { kind: 'name-keyed-array' }
  | { kind: 'namespace-array' }
  | { kind: 'singleton'; bindingRequired: boolean }
  | { kind: 'binding-list'; bindingsRequired: boolean }
  | { kind: 'whole-object' };

/**
 * Explicit per-field shape metadata (see {@link BindingFieldShape}), transcribed
 * from wrangler 4.131's config schema. Any `FRIENDLY_BINDING_NAMES` field absent here is
 * a `namespace-array` (`[{ binding }]`) — the shape wrangler's `getBindingNames` reads
 * via its `isNamespaceList` branch.
 */
const BINDING_FIELD_SHAPES: Record<string, BindingFieldShape> = {
  // Key-maps — the KEYS are the binding names (env var / module / blob names). Never
  // read the VALUES, so a value that looks like a binding list/object is not misread.
  vars: { kind: 'key-map' },
  wasm_modules: { kind: 'key-map' },
  text_blobs: { kind: 'key-map' },
  data_blobs: { kind: 'key-map' },
  // Name-keyed arrays — identity on `.name` (wrangler's `getBindingNames` overlooks
  // these; `validateSendEmailBinding`/`validateRateLimitBinding` require `.name`).
  send_email: { kind: 'name-keyed-array' },
  ratelimits: { kind: 'name-keyed-array' },
  // Whole-object — no per-entry binding identity; the deploy verifier compares the
  // whole value against the pre-build root (see the shape table).
  addresses: { kind: 'whole-object' },
  // Singletons `{ binding }` — `binding` REQUIRED per schema for all except `assets`
  // (`validateAssetsConfig`, where a binding-less assets-only-directory is legal).
  ai: { kind: 'singleton', bindingRequired: true },
  browser: { kind: 'singleton', bindingRequired: true },
  images: { kind: 'singleton', bindingRequired: true },
  stream: { kind: 'singleton', bindingRequired: true },
  media: { kind: 'singleton', bindingRequired: true },
  websearch: { kind: 'singleton', bindingRequired: true },
  version_metadata: { kind: 'singleton', bindingRequired: true },
  assets: { kind: 'singleton', bindingRequired: false },
  // Binding lists `{ bindings: [{ name }] }` — `bindings` REQUIRED for durable_objects
  // and logfwdr; OPTIONAL for `unsafe` (which may carry only `metadata`).
  durable_objects: { kind: 'binding-list', bindingsRequired: true },
  logfwdr: { kind: 'binding-list', bindingsRequired: true },
  unsafe: { kind: 'binding-list', bindingsRequired: false },
};

/**
 * The ONE field-aware strict binding-name reader for a single config field. Routes
 * each field to its KNOWN shape (see {@link BINDING_FIELD_SHAPES}) and FAILS CLOSED on
 * any malformed/missing REQUIRED identity or wrong outer shape — never content-guessing.
 * wrangler is lenient and would silently drop such a member, letting the worker-wide
 * uniqueness guard miss (or invent) a collision.
 *
 * Exported so the deploy orchestrator's pass-through assert-set check reads a resource field's
 * per-entry identity keys through the SAME wrangler-schema shapes (handling `send_email` /
 * `ratelimits` name-keying and `logfwdr`'s nested `.bindings`, among others).
 */
export function bindingNamesForField(field: string, value: unknown): Array<string> {
  const shape: BindingFieldShape = BINDING_FIELD_SHAPES[field] ?? { kind: 'namespace-array' };
  switch (shape.kind) {
    case 'key-map':
      return keyMapBindingNames(field, value);
    case 'name-keyed-array':
      return nameKeyedBindingNames(field, value);
    case 'namespace-array':
      return namespaceArrayBindingNames(field, value);
    case 'singleton':
      return singletonBindingName(field, value, shape.bindingRequired);
    case 'binding-list':
      return bindingListNames(field, value, shape.bindingsRequired);
    case 'whole-object':
      return [];
  }
}

/**
 * The entry-shaped sibling of {@link bindingNamesForField}: routes each field to its KNOWN
 * shape and returns every binding's NAME **paired with its full config ENTRY object**, so a
 * caller can compare not just WHICH bindings a field declares but the TARGET each one points
 * at (a `services` binding's `service`, an `unsafe` binding's `type`, …). Same fail-closed
 * philosophy as {@link bindingNamesForField} — a malformed/missing REQUIRED identity or wrong
 * outer shape THROWS. By construction `bindingEntriesForField(f, v).map((e) => e.name)` equals
 * `bindingNamesForField(f, v)` for every field (both read identity through the same shapes).
 *
 * Exported so the deploy orchestrator's pass-through assert-set check can pin a legitimately
 * hand-declared binding's ENTRY pre-build and reject a build that KEEPS the name but REWRITES
 * the target.
 */
export function bindingEntriesForField(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  const shape: BindingFieldShape = BINDING_FIELD_SHAPES[field] ?? { kind: 'namespace-array' };
  switch (shape.kind) {
    case 'key-map':
      return keyMapBindingEntries(field);
    case 'name-keyed-array':
      return nameKeyedBindingEntries(field, value);
    case 'namespace-array':
      return namespaceArrayBindingEntries(field, value);
    case 'singleton':
      return singletonBindingEntry(field, value, shape.bindingRequired);
    case 'binding-list':
      return bindingListEntries(field, value, shape.bindingsRequired);
    case 'whole-object':
      return [];
  }
}

/**
 * Entry-shaped reader for a KEY-MAP field. Key-map fields (vars/wasm_modules/text_blobs/
 * data_blobs) carry no per-binding config ENTRY object — the binding name is the KEY and the
 * VALUE is arbitrary content — and all four are excluded from the pass-through assert-set, so
 * this branch is never reached in the normal flow. It THROWS the same wrong-shape message the
 * name reader raises, so a FUTURE misclassification that routed a key-map field here fails
 * CLOSED rather than silently reading no entries.
 */
function keyMapBindingEntries(field: string): never {
  throw new Error(
    `deploy: cannot verify binding-name uniqueness — "${field}" must be an object mapping names ` +
      `to values. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
      `could hide a real collision). Fix the wrangler config and retry.`,
  );
}

/**
 * Entry-shaped reader for a NAMESPACE-array field (mirror of {@link namespaceArrayBindingNames}):
 * a PRESENT non-array THROWS; every member is strictly validated for a non-empty string
 * `.binding` and returned with its full entry object.
 */
function namespaceArrayBindingEntries(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an array of binding ` +
        `entries. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingEntries(value, 'binding', field);
}

/**
 * Entry-shaped reader for a NAME-keyed array field (mirror of {@link nameKeyedBindingNames}):
 * identity is `.name` only; a PRESENT non-array THROWS; every member is strictly validated.
 */
function nameKeyedBindingEntries(
  field: string,
  value: unknown,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an array of binding ` +
        `entries. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingEntries(value, 'name', field);
}

/**
 * Entry-shaped reader for a binding-LIST field (mirror of {@link bindingListNames}): the entry
 * of each member is the member itself (`{ name, ... }`), keyed on `.name`. Same throw semantics
 * as the name reader — a wrong outer shape, or a required-but-missing `bindings`, THROWS; a
 * `bindings`-less `unsafe` (optional) contributes nothing.
 */
function bindingListEntries(
  field: string,
  value: unknown,
  bindingsRequired: boolean,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object with a ` +
        `"bindings" array. Refusing to proceed on a partially-readable binding set (a wrong-shaped ` +
        `field could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (value.bindings === undefined) {
    if (bindingsRequired) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "${field}" requires a "bindings" array. ` +
          `Refusing to proceed on a partially-readable binding set (a wrong-shaped field could hide ` +
          `a real collision). Fix the wrangler config and retry.`,
      );
    }
    return [];
  }
  if (!Array.isArray(value.bindings)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}.bindings" must be an array. ` +
        `Refusing to proceed on a partially-readable binding set (a wrong-shaped field could hide ` +
        `a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingEntries(value.bindings, 'name', `${field}.bindings`);
}

/**
 * Entry-shaped reader for a SINGLETON field (mirror of {@link singletonBindingName}): the entry
 * is the singleton value itself. A PRESENT non-object THROWS; a present-but-malformed `binding`
 * THROWS; a required-but-absent `binding` THROWS; a binding-optional `assets` with no binding
 * contributes nothing.
 */
function singletonBindingEntry(
  field: string,
  value: unknown,
  bindingRequired: boolean,
): Array<{ name: string; entry: Record<string, unknown> }> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object with a ` +
        `"binding". Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (typeof value.binding === 'string' && value.binding.length > 0) {
    return [{ name: value.binding, entry: value }];
  }
  if (value.binding !== undefined) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" has a malformed "binding" ` +
        `(expected a non-empty string). Refusing to proceed on a partially-readable binding set (a ` +
        `dropped binding could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (bindingRequired) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" requires a "binding" (a ` +
        `non-empty string). Refusing to proceed on a partially-readable binding set (a dropped ` +
        `binding could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return [];
}

/**
 * Read binding names from a KEY-MAP field (`vars`/`wasm_modules`/`text_blobs`/
 * `data_blobs`): the object's KEYS are the binding names. Reads ONLY the keys — never
 * the values — so a value that happens to look like a binding list (`{bindings:[…]}`)
 * or a singleton (`{binding:'x'}`) is NOT misread (the old generic path returned the
 * VALUE, or a nested `name`, instead of the real KEY). A PRESENT value that is not a
 * plain object is the wrong outer shape and THROWS (fail closed). An explicitly
 * `undefined`-valued key is not a real binding and is skipped.
 */
function keyMapBindingNames(field: string, value: unknown): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object mapping names ` +
        `to values. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * Read binding names from a NAMESPACE-array field (`[{ binding }]`: kv_namespaces,
 * d1_databases, r2_buckets, hyperdrive, services, vectorize, …). A PRESENT value that
 * is not an array is the wrong outer shape and THROWS rather than being re-read as a
 * key-map (which could under-collect and hide a real collision); every member is
 * strictly validated for a non-empty string `.binding`.
 */
function namespaceArrayBindingNames(field: string, value: unknown): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an array of binding ` +
        `entries. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingArray(value, 'binding', field);
}

/**
 * Read binding names from a NAME-keyed array field (`send_email` / `ratelimits`:
 * an array of `{ name }`). Encodes the field's REQUIRED outer shape: a PRESENT value that
 * is not an array THROWS (fail closed) rather than falling back to generic key collection —
 * wrangler validates these via `validateBindingArray`, so a non-array is malformed and
 * could hide a real collision if silently re-read as a key-map. An ABSENT value contributes
 * nothing. Every array member is strictly validated (a malformed one rejects the whole
 * config).
 *
 * Identity is the `.name` ONLY. Verified against wrangler 4.131's bundle +
 * `config-schema.json`: NEITHER `send_email` NOR `ratelimits` has a `.binding` property in
 * the schema, and on UPLOAD wrangler keys them by `.name` (send_email:
 * `output[name] = { type: "send_email", ...}`; ratelimits push `{ name: binding.name, … }`).
 * An optional `.binding` that happens to sit on such an entry is NOT a binding identity
 * wrangler recognizes, so unioning it invents a PHANTOM collision — e.g. a
 * `send_email:[{name:"EMAIL_A",binding:"QUEUE_JOBS"}]` would falsely block a legitimate
 * `QUEUE_JOBS` queue producer / adopt / read-first. We therefore collect ONLY the `.name`
 * of every member (a genuine same-`name` collision is still caught).
 */
function nameKeyedBindingNames(field: string, value: unknown): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an array of binding ` +
        `entries. Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingArray(value, 'name', field);
}

/**
 * Read the binding names from a binding-LIST field (`{ bindings: [{ name }] }`:
 * durable_objects / logfwdr / unsafe). A PRESENT value that is not an object is the
 * wrong outer shape and THROWS. When `bindingsRequired` (durable_objects / logfwdr per
 * schema), a MISSING `bindings` array THROWS (never a silent empty read); `unsafe` is
 * optional, so a `bindings`-less `{ metadata }` contributes nothing. A PRESENT
 * `bindings` array has EVERY member strictly validated for a non-empty string `name`.
 */
function bindingListNames(field: string, value: unknown, bindingsRequired: boolean): Array<string> {
  if (value === undefined) {
    return [];
  }
  // Encode the REQUIRED outer shape: a binding-list field must be an object; a
  // wrong-shaped value (array, string, …) THROWS rather than under-collecting (which
  // could hide a real binding collision).
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object with a ` +
        `"bindings" array. Refusing to proceed on a partially-readable binding set (a wrong-shaped ` +
        `field could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (value.bindings === undefined) {
    if (bindingsRequired) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "${field}" requires a "bindings" array. ` +
          `Refusing to proceed on a partially-readable binding set (a wrong-shaped field could hide ` +
          `a real collision). Fix the wrangler config and retry.`,
      );
    }
    return [];
  }
  if (!Array.isArray(value.bindings)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}.bindings" must be an array. ` +
        `Refusing to proceed on a partially-readable binding set (a wrong-shaped field could hide ` +
        `a real collision). Fix the wrangler config and retry.`,
    );
  }
  return strictBindingArray(value.bindings, 'name', `${field}.bindings`);
}

/**
 * Read the binding name from a SINGLETON field (`{ binding }`: ai / browser /
 * images / stream / media / websearch / version_metadata / assets). A PRESENT value
 * that is not an object is the wrong outer shape and THROWS. A PRESENT-but-malformed
 * `binding` (non-string / empty) THROWS. When `bindingRequired` (every singleton except
 * `assets`, per schema), an ABSENT `binding` also THROWS — never a silent empty read,
 * and never a fall-through that would mis-collect the object's OTHER keys (e.g.
 * `{ staging: true }`) as bogus binding names. `assets` is binding-optional, so an
 * absent binding (e.g. `{ directory }`) contributes nothing.
 */
function singletonBindingName(
  field: string,
  value: unknown,
  bindingRequired: boolean,
): Array<string> {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" must be an object with a ` +
        `"binding". Refusing to proceed on a partially-readable binding set (a wrong-shaped field ` +
        `could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (typeof value.binding === 'string' && value.binding.length > 0) {
    return [value.binding];
  }
  if (value.binding !== undefined) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" has a malformed "binding" ` +
        `(expected a non-empty string). Refusing to proceed on a partially-readable binding set (a ` +
        `dropped binding could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  if (bindingRequired) {
    throw new Error(
      `deploy: cannot verify binding-name uniqueness — "${field}" requires a "binding" (a ` +
        `non-empty string). Refusing to proceed on a partially-readable binding set (a dropped ` +
        `binding could hide a real collision). Fix the wrangler config and retry.`,
    );
  }
  return [];
}

/**
 * Strictly read `keyField` (a non-empty string) from EVERY member of a
 * binding-bearing array. THROWS (fail closed) on ANY malformed member — never
 * silently drops one. Dropping a malformed member could convert a mixed-validity
 * array (e.g. `[null, { binding: 'DB', id: '…' }]`) into an empty/partial binding
 * set, so the worker-wide uniqueness guard would MISS the existing `DB` and commit
 * a conflicting binding — a fail-open in a documented invariant. Mirrors the
 * writer's existing fail-closed-on-malformed-config philosophy.
 */
function strictBindingArray(
  members: Array<unknown>,
  keyField: 'binding' | 'name',
  field: string,
): Array<string> {
  return strictBindingEntries(members, keyField, field).map((e) => e.name);
}

/**
 * The entry-shaped sibling of {@link strictBindingArray}: reads `keyField` (a non-empty string)
 * from EVERY member and returns it PAIRED with the member's full entry object. Same fail-closed
 * validation — a non-record member, or one missing a non-empty string `keyField`, THROWS (never
 * silently dropped). {@link strictBindingArray} is defined in terms of this, so the two agree on
 * names and error messages for every field.
 */
function strictBindingEntries(
  members: Array<unknown>,
  keyField: 'binding' | 'name',
  field: string,
): Array<{ name: string; entry: Record<string, unknown> }> {
  return members.map((member, index) => {
    if (
      !isRecord(member) ||
      typeof member[keyField] !== 'string' ||
      (member[keyField] as string).length === 0
    ) {
      throw new Error(
        `deploy: cannot verify binding-name uniqueness — "${field}" contains a malformed entry at ` +
          `index ${index} (missing a non-empty string "${keyField}"). Refusing to proceed on a ` +
          `partially-readable binding set (a dropped entry could hide a real collision). Fix the ` +
          `wrangler config and retry.`,
      );
    }
    return { name: member[keyField] as string, entry: member };
  });
}

/**
 * True when a D1 `migrations_pattern` is valid under `dir` per wrangler's rule:
 * the normalized pattern must start with `${normalized dir}/` (or the dir
 * normalizes to "."). Mirrors wrangler's `resolveMigrationsConfig` /
 * `stripDirPrefix`.
 */
function migrationsPatternMatchesDir(pattern: string, dir: string): boolean {
  const normalizedDir = normalizeMigrationsPath(dir);
  if (normalizedDir === '.') {
    return true;
  }
  return normalizeMigrationsPath(pattern).startsWith(`${normalizedDir}/`);
}

/**
 * Mirror wrangler's `normalizeRelativePath`: forward-slash, posix-normalize, then
 * drop a trailing slash. Keeps the migrations validity check byte-identical with
 * wrangler's own.
 */
function normalizeMigrationsPath(p: string): string {
  const normalized = normalize(p.replace(/\\/g, '/'));
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
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
