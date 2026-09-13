import { existsSync, readFileSync } from 'node:fs';
import { parse as parseJsoncConfig, type ParseError } from 'jsonc-parser';

/** Parse a root Wrangler JSON/JSONC config without accepting a partial parse. */
export function parseRootWranglerConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return {};
  }
  const content = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const errors: Array<ParseError> = [];
  const parsed = parseJsoncConfig(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function readWranglerTopLevelString(
  config: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = config[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readStoredResourceName(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  nameField: string,
): string | undefined {
  const list = config[field];
  if (!Array.isArray(list)) {
    return undefined;
  }
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { binding?: unknown }).binding === binding
    ) {
      const name = (entry as Record<string, unknown>)[nameField];
      return typeof name === 'string' && name.length > 0 ? name : undefined;
    }
  }
  return undefined;
}

export function readBindingFieldPresence(
  config: Record<string, unknown>,
  field: string,
  binding: string,
  key: string,
): { present: boolean; value: unknown } {
  const list = config[field];
  if (!Array.isArray(list)) {
    return { present: false, value: undefined };
  }
  for (const entry of list) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { binding?: unknown }).binding === binding
    ) {
      return Object.hasOwn(entry as object, key)
        ? { present: true, value: (entry as Record<string, unknown>)[key] }
        : { present: false, value: undefined };
    }
  }
  return { present: false, value: undefined };
}

export function readConfigEntryString(entry: unknown, field: string): string | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveD1MigrateTarget(
  config: Record<string, unknown>,
  binding: string,
): { ok: true; token: string } | { ok: false; reason: string } {
  const list = config.d1_databases;
  if (!Array.isArray(list)) {
    return { ok: false, reason: `the root config has no "d1_databases" array` };
  }
  const validatedIndex = list.findIndex(
    (entry) => readConfigEntryString(entry, 'binding') === binding,
  );
  if (validatedIndex === -1) {
    return { ok: false, reason: `no d1_databases entry has binding ${JSON.stringify(binding)}` };
  }
  const validated = list[validatedIndex];
  const token = readConfigEntryString(validated, 'database_name') ?? binding;
  for (let i = 0; i < validatedIndex; i++) {
    const earlier = list[i];
    if (
      readConfigEntryString(earlier, 'database_name') === token ||
      readConfigEntryString(earlier, 'binding') === token
    ) {
      return {
        ok: false,
        reason:
          `an earlier d1_databases entry (binding ${JSON.stringify(readConfigEntryString(earlier, 'binding'))}, ` +
          `database_name ${JSON.stringify(readConfigEntryString(earlier, 'database_name'))}) also matches the ` +
          `token ${JSON.stringify(token)}, so wrangler would migrate it instead`,
      };
    }
  }
  return { ok: true, token };
}
