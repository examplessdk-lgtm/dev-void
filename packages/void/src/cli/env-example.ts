/**
 * `void env example` — generate a `.env.example` block from the registered
 * env schema, managed as a marker-delimited section so any user-managed
 * entries (CI tokens, build flags, etc.) above or below the block survive
 * a refresh.
 *
 * Marker convention mirrors the one used by `init.ts` for CLAUDE.md /
 * AGENTS.md instructions: a literal start marker, a body, and a literal
 * end marker. The markers are hash-prefixed so they remain valid dotenv
 * comments and don't trip up tools that parse `.env` files.
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
import { log, outro } from '@clack/prompts';
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
 * Build the body of the managed env block (no markers) from a registered
 * schema map.
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

  const writeGroup = (label: string, group: EnvExampleEntry[]) => {
    if (group.length === 0) {
      return;
    }
    if (lines.length > 0) {
      lines.push('');
    }
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

  // Trailing newline so the body terminates cleanly before the end marker.
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/**
 * Literal start/end markers for the void-managed block. They are valid
 * dotenv comments (hash-prefixed) so any tool that parses `.env.example`
 * silently ignores them, and they are matched as whole lines (with
 * defensive trailing-whitespace tolerance) when locating the block.
 */
export const ENV_EXAMPLE_START_MARKER =
  '# >>> void env: managed block — do not edit between markers <<<';
export const ENV_EXAMPLE_END_MARKER = '# >>> end void env <<<';
const ENV_EXAMPLE_MARKER_HINT = '# Run `void env example` to refresh.';

/** Regex matchers for the markers — full line, ignore trailing whitespace. */
const START_MARKER_RE = new RegExp(
  `^${ENV_EXAMPLE_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
);
const END_MARKER_RE = new RegExp(
  `^${ENV_EXAMPLE_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
);

function buildMarkerBlock(body: string): string {
  // Body already terminates with `\n` when non-empty (see `formatEnvExample`).
  // Drop the trailing newline so the end marker sits flush, then re-add a
  // single newline after the end marker for POSIX-friendly files.
  const trimmedBody = body.endsWith('\n') ? body.slice(0, -1) : body;
  const parts = [ENV_EXAMPLE_START_MARKER, ENV_EXAMPLE_MARKER_HINT];
  if (trimmedBody.length > 0) {
    parts.push(trimmedBody);
  }
  parts.push(ENV_EXAMPLE_END_MARKER);
  return parts.join('\n') + '\n';
}

export type ApplyMarkerAction = 'create' | 'replace' | 'append' | 'error';

export interface ApplyMarkerResult {
  content: string;
  action: ApplyMarkerAction;
  reason?: string;
}

/**
 * Pure helper that produces the new `.env.example` content given the
 * existing file contents (or `null` when the file does not exist) and the
 * formatted env body (without marker lines).
 *
 * Behavior matrix:
 *   - existing == null               → `create` a fresh marker-only file
 *   - both markers present           → `replace` the lines between them
 *   - no markers present             → `append` the block at the end
 *   - exactly one marker present     → `error` (mismatched markers)
 */
export function applyMarkerBlock(existing: string | null, body: string): ApplyMarkerResult {
  const block = buildMarkerBlock(body);

  if (existing === null) {
    return { content: block, action: 'create' };
  }

  const lines = existing.split('\n');
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startIdx === -1 && START_MARKER_RE.test(lines[i])) {
      startIdx = i;
      continue;
    }
    if (startIdx !== -1 && END_MARKER_RE.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  // Independently locate an end marker even if no start marker was found,
  // so we can detect the "end without start" mismatch case.
  const hasStart = lines.some((l) => START_MARKER_RE.test(l));
  const hasEnd = lines.some((l) => END_MARKER_RE.test(l));

  if (hasStart && !hasEnd) {
    return {
      content: existing,
      action: 'error',
      reason:
        'Found start marker but no matching end marker in .env.example. Restore `# >>> end void env <<<` or delete the file and re-run `void env example`.',
    };
  }
  if (!hasStart && hasEnd) {
    return {
      content: existing,
      action: 'error',
      reason:
        'Found end marker but no matching start marker in .env.example. Restore `# >>> void env: ... <<<` or delete the file and re-run `void env example`.',
    };
  }

  if (startIdx !== -1 && endIdx !== -1) {
    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx + 1);
    // `block` already has its own trailing newline. Splice as text:
    // join before + block + after, taking care to preserve the file's
    // original trailing-newline shape from `after`.
    const beforeText = before.length > 0 ? before.join('\n') + '\n' : '';
    const afterText = after.join('\n');
    return { content: beforeText + block + afterText, action: 'replace' };
  }

  // Append: separate from existing content with a single blank line, and
  // tolerate files that don't end in a newline.
  const trimmed = existing.replace(/\s+$/, '');
  const separator = trimmed.length > 0 ? '\n\n' : '';
  return { content: trimmed + separator + block, action: 'append' };
}

export interface RunEnvExampleOptions {
  /** Suppress informational notes (e.g. the "appended block" message) for scripts. */
  force: boolean;
}

/** CLI entrypoint: load schema, manage marker block, write `.env.example`. */
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
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;
  const body = formatEnvExample(schema);
  const result = applyMarkerBlock(existing, body);

  if (result.action === 'error') {
    log.error(result.reason ?? 'Failed to update .env.example.');
    process.exit(1);
  }

  // Don't rewrite if content is identical — keeps mtime stable for CI/caching.
  if (existing !== null && existing === result.content) {
    outro('.env.example is already up to date.');
    return;
  }

  writeFileSync(outPath, result.content);
  const count = Object.keys(schema).length;
  const keyCount = `${count} key${count === 1 ? '' : 's'}`;
  if (result.action === 'create') {
    log.success(`Wrote .env.example (${keyCount}).`);
  } else if (result.action === 'replace') {
    log.success(`Refreshed void env block in .env.example (${keyCount}).`);
  } else if (result.action === 'append') {
    log.success(`Refreshed void env block in .env.example (${keyCount}).`);
    if (!options.force) {
      log.info('appended void env block to existing .env.example');
    }
  }
  outro('Done.');
}
