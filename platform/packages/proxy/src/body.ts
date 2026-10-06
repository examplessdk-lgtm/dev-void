import { isRecord } from '@void/deploy-core';

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isQueryValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
