import type { ProxyBody } from './types.ts';

export function isProxyBody(value: unknown): value is ProxyBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isProxyBody(value) ? value : {};
}

export function isQueryValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
