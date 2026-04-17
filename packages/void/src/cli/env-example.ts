/**
 * `void env example` — generate `.env.example` from the registered env schema.
 *
 * Reads the user's `env.ts` (via the same dynamic-import pattern as
 * `env-validation.ts`), introspects each declared key's schema using its
 * Standard Schema `validate` entry point, and writes a grouped, commented
 * `.env.example` file to the project root.
 *
 * Schema introspection strategy:
 *   - Call `schema['~standard'].validate(undefined)`:
 *       • `{ value: undefined }` → optional (no default)
 *       • `{ value: <x> }`       → has a default (value is `<x>`)
 *       • `{ issues: [...] }`    → required
 *   - For enum hints, probe with a sentinel that is unlikely to match and
 *     parse the built-in `oneOf` error message ("Expected one of A, B, got ..."),
 *     yielding the valid values. This only works for Void's built-in
 *     `oneOf()` helper — third-party validators silently degrade to no hint,
 *     which is fine because `.env.example` is purely informational.
 *
 * This keeps the introspection layer Standard Schema-friendly (no private
 * fields, no type-widening) while still giving a good DX for the common
 * Void helpers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { confirm, isCancel, log, outro } from '@clack/prompts';
import { findEnvFile } from '../codegen/env-types';
import type { StandardSchemaV1 } from '../standard-schema';

interface EnvPublicModule {
  _getRegisteredSchema(): Record<string, StandardSchemaV1<unknown, unknown>> | null;
}

/** Load the user's env.ts so `defineEnv` registers the schema. */
async function loadRegisteredSchema(
  envFile: string,
): Promise<Record<string, StandardSchemaV1<unknown, unknown>> | null> {
  const url = pathToFileURL(envFile).href + `?t=${Date.now()}`;
  try {
    await import(/* @vite-ignore */ url);
  } catch (err) {
    throw new Error(`Failed to load ${envFile}: ${(err as Error).message}`);
  }
  const mod = (await import('../runtime/env-public')) as unknown as EnvPublicModule;
  return mod._getRegisteredSchema();
}

/** Classification of a single env key for display. */
export type EntryKind =
  | { kind: 'required'; enumValues?: string[] }
  | { kind: 'default'; defaultValue: unknown; enumValues?: string[] }
  | { kind: 'optional'; enumValues?: string[] };

export interface EnvExampleEntry {
  key: string;
  classification: EntryKind;
}

/**
 * Introspect a single schema into an {@link EntryKind}.
 *
 * The probing logic is pure: it only calls the public `~standard.validate`
 * contract, so it works for any Standard Schema-compliant validator.
 */
export function classifySchema(schema: StandardSchemaV1<unknown, unknown>): EntryKind {
  const enumValues = tryExtractEnumValues(schema);

  const probe = schema['~standard'].validate(undefined);
  if (probe instanceof Promise) {
    // Async validators can't be introspected synchronously; treat as required
    // (safest default — users must supply a value).
    return { kind: 'required', enumValues };
  }

  if ('issues' in probe && probe.issues) {
    return { kind: 'required', enumValues };
  }
  // Success path: distinguish optional (value === undefined) vs default.
  if (probe.value === undefined) {
    return { kind: 'optional', enumValues };
  }
  return { kind: 'default', defaultValue: probe.value, enumValues };
}

/**
 * Attempt to pull enum values out of a Void `oneOf()` schema by probing with
 * an invalid sentinel and parsing the error message. Returns undefined for
 * any schema that isn't a built-in `oneOf`.
 */
function tryExtractEnumValues(schema: StandardSchemaV1<unknown, unknown>): string[] | undefined {
  const sentinel = '__void_env_example_probe__';
  const result = schema['~standard'].validate(sentinel);
  if (result instanceof Promise) {
    return undefined;
  }
  if (!('issues' in result) || !result.issues || result.issues.length === 0) {
    return undefined;
  }
  const message = result.issues[0].message;
  // Built-in oneOf message: `Expected one of A, B, C, got "..."`
  const match = /^Expected one of (.+), got "/.exec(message);
  if (!match) {
    return undefined;
  }
  return match[1].split(',').map((s) => s.trim());
}

/** Serialize a default value into a dotenv-friendly string. */
function serializeDefault(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects / arrays from json().default(...): stringify.
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Build `.env.example` content from a registered schema map.
 *
 * Grouped by:
 *   1. required (no default, not optional)
 *   2. required with default (prefilled value)
 *   3. optional (empty value)
 *
 * Enum-valued keys get a leading `# enum: A | B | C` comment.
 */
export function formatEnvExample(
  schema: Record<string, StandardSchemaV1<unknown, unknown>>,
): string {
  const entries: EnvExampleEntry[] = Object.entries(schema).map(([key, s]) => ({
    key,
    classification: classifySchema(s),
  }));

  const required = entries.filter((e) => e.classification.kind === 'required');
  const withDefault = entries.filter((e) => e.classification.kind === 'default');
  const optional = entries.filter((e) => e.classification.kind === 'optional');

  const lines: string[] = [];
  lines.push('# Generated by void — do not edit by hand');
  lines.push('# Run `void env example` to refresh');

  const writeGroup = (label: string, group: EnvExampleEntry[]) => {
    if (group.length === 0) {
      return;
    }
    lines.push('');
    lines.push(`# ${label}`);
    for (const entry of group) {
      const enumValues = entry.classification.enumValues;
      if (enumValues && enumValues.length > 0) {
        lines.push(`# enum: ${enumValues.join(' | ')}`);
      }
      if (entry.classification.kind === 'default') {
        lines.push(`${entry.key}=${serializeDefault(entry.classification.defaultValue)}`);
      } else {
        lines.push(`${entry.key}=`);
      }
    }
  };

  writeGroup('required', required);
  writeGroup('with defaults', withDefault);
  writeGroup('optional', optional);

  // Trailing newline for POSIX-style files.
  return lines.join('\n') + '\n';
}

export interface RunEnvExampleOptions {
  /** Skip the overwrite prompt when a `.env.example` already exists. */
  force: boolean;
}

/** CLI entrypoint: load schema, confirm overwrite, write `.env.example`. */
export async function runEnvExample(root: string, options: RunEnvExampleOptions): Promise<void> {
  const envFile = findEnvFile(root);
  if (!envFile) {
    outro('No env.ts found at project root — nothing to generate.');
    return;
  }
  const schema = await loadRegisteredSchema(envFile);
  if (!schema || Object.keys(schema).length === 0) {
    outro('env.ts registered no keys — nothing to generate.');
    return;
  }

  const outPath = join(root, '.env.example');
  if (existsSync(outPath) && !options.force) {
    const proceed = await confirm({
      message: `.env.example already exists. Overwrite?`,
    });
    if (isCancel(proceed) || !proceed) {
      outro('Aborted.');
      return;
    }
  }

  const content = formatEnvExample(schema);
  // Don't rewrite if content is identical — keeps mtime stable for CI/caching.
  if (existsSync(outPath) && readFileSync(outPath, 'utf-8') === content) {
    outro('.env.example is already up to date.');
    return;
  }
  writeFileSync(outPath, content);
  const count = Object.keys(schema).length;
  log.success(`Wrote .env.example (${count} key${count === 1 ? '' : 's'}).`);
  outro('Done.');
}
