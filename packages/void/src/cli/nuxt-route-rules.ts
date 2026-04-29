import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeConfigRevalidate, type RevalidateConfig } from './revalidate';
import type {
  HeaderRule,
  IsrFallbackRule,
  RedirectRule,
  RevalidateKind,
  RevalidateQueryPolicy,
  RevalidateRule,
  RevalidateTtl,
} from './types';

export interface ImportedNuxtRouteRules {
  revalidate: Array<RevalidateRule>;
  prerender: Array<string>;
  headerRules: Array<HeaderRule>;
  redirectRules: Array<RedirectRule>;
  isrFallbacks: Array<IsrFallbackRule>;
  warnings: Array<string>;
}

export function importNuxtRouteRules(root: string): ImportedNuxtRouteRules {
  const routeRules = readGeneratedRouteRules(root);
  const imported: ImportedNuxtRouteRules = {
    revalidate: [],
    prerender: [],
    headerRules: [],
    redirectRules: [],
    isrFallbacks: [],
    warnings: [],
  };

  if (!routeRules) {
    return imported;
  }

  const warned = new Set<string>();
  const warnOnce = (message: string) => {
    if (!warned.has(message)) {
      warned.add(message);
      imported.warnings.push(message);
    }
  };

  for (const [patternRaw, ruleUnknown] of Object.entries(routeRules)) {
    if (!ruleUnknown || typeof ruleUnknown !== 'object' || Array.isArray(ruleUnknown)) {
      continue;
    }
    const pattern = normalizeNitroPattern(patternRaw);
    const rule = ruleUnknown as Record<string, unknown>;
    const kind = inferRevalidateKind(pattern);

    const isrTtl = ttlFromIsr(rule.isr);
    if (isrTtl !== undefined) {
      imported.revalidate.push({
        pattern,
        ttl: isrTtl,
        query: queryPolicyFromIsr(rule.isr),
        kind,
        source: 'framework',
      });
    }

    if (isrTtl === undefined) {
      const swrTtl = ttlFromSwr(rule.swr);
      if (swrTtl === 'skip-unbounded') {
        warnOnce('Skipping Nuxt routeRules with swr: true; unbounded SWR is not represented yet.');
      } else if (swrTtl !== undefined) {
        imported.revalidate.push({
          pattern,
          ttl: swrTtl,
          query: false,
          kind,
          source: 'framework',
        });
      }

      const cacheTtl = ttlFromSafeCache(rule.cache, rule);
      if (cacheTtl === 'skip-unsupported') {
        warnOnce('Skipping Nuxt routeRules with unsupported cache key or invalidation behavior.');
      } else if (cacheTtl !== undefined && swrTtl === undefined) {
        imported.revalidate.push({
          pattern,
          ttl: cacheTtl,
          query: false,
          kind,
          source: 'framework',
        });
      }
    }

    if (rule.prerender === true && !pattern.includes('*')) {
      imported.prerender.push(pattern);
    }

    if (rule.headers && typeof rule.headers === 'object' && !Array.isArray(rule.headers)) {
      const headers = Object.entries(rule.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, value]) => [name, value] as [string, string]);
      if (headers.length > 0) {
        imported.headerRules.push({ pattern, headers });
      }
    }

    const redirect = redirectFromNitroRule(pattern, rule);
    if (redirect) {
      imported.redirectRules.push(redirect);
    }

    const fallback = fallbackFromNitroRule(pattern, rule);
    if (fallback) {
      imported.isrFallbacks.push(fallback);
    }

    if (rule.proxy !== undefined) {
      warnOnce('Skipping Nuxt routeRules proxy entries; implement proxies in app server handlers.');
    }
  }

  imported.prerender = [...new Set(imported.prerender)];
  return imported;
}

export function mergeStructuredRevalidate(
  imported: Array<RevalidateRule>,
  config: RevalidateConfig | undefined,
): RevalidateConfig | undefined {
  if (config == null) {
    return imported.length > 0 ? imported : undefined;
  }
  if (config === 0) {
    return config;
  }
  const configRules = normalizeConfigRevalidate(config);
  if (imported.length === 0 && !Array.isArray(config)) {
    return config;
  }

  const result = [...imported];
  for (const configRule of configRules) {
    const kind = configRule.kind ?? 'page';
    const index = result.findIndex(
      (rule) => rule.pattern === configRule.pattern && (rule.kind ?? 'page') === kind,
    );
    if (index === -1) {
      result.push(configRule);
    } else {
      result[index] = configRule;
    }
  }
  return result.length > 0 ? result : undefined;
}

function readGeneratedRouteRules(root: string): Record<string, unknown> | null {
  const nitroJson = join(root, '.output', 'nitro.json');
  if (!existsSync(nitroJson)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(nitroJson, 'utf-8')) as Record<string, unknown>;
    const config = parsed.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return null;
    }
    const routeRules = (config as Record<string, unknown>).routeRules;
    if (!routeRules || typeof routeRules !== 'object' || Array.isArray(routeRules)) {
      return null;
    }
    return routeRules as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeNitroPattern(pattern: string): string {
  const normalized = pattern.replaceAll('/**', '/*').replaceAll('**', '*');
  if (normalized === '*') {
    return '*';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function inferRevalidateKind(pattern: string): RevalidateKind {
  if (
    pattern === '/api' ||
    pattern.startsWith('/api/') ||
    /\.(json|txt|xml|svg)(\*|$)/.test(pattern)
  ) {
    return 'api';
  }
  return 'page';
}

function ttlFromIsr(value: unknown): RevalidateTtl | undefined {
  if (value === true) {
    return 'deploy';
  }
  if (value === false) {
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const isr = value as Record<string, unknown>;
    if (isr.expiration === false) {
      return 'deploy';
    }
    if (
      typeof isr.expiration === 'number' &&
      Number.isFinite(isr.expiration) &&
      isr.expiration >= 0
    ) {
      return isr.expiration;
    }
  }
  return undefined;
}

function ttlFromSwr(value: unknown): RevalidateTtl | 'skip-unbounded' | undefined {
  if (value === true) {
    return 'skip-unbounded';
  }
  if (value === false) {
    return 0;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function ttlFromSafeCache(
  cacheUnknown: unknown,
  rule: Record<string, unknown>,
): number | 'skip-unsupported' | undefined {
  if (cacheUnknown === false) {
    return 0;
  }
  if (!cacheUnknown || typeof cacheUnknown !== 'object' || Array.isArray(cacheUnknown)) {
    return undefined;
  }
  const cache = cacheUnknown as Record<string, unknown>;
  if (typeof cache.maxAge !== 'number' || !Number.isFinite(cache.maxAge) || cache.maxAge < 0) {
    return undefined;
  }
  if (cache.maxAge === 0) {
    return 0;
  }
  const unsupported = [
    'varies',
    'getKey',
    'shouldBypassCache',
    'shouldInvalidateCache',
    'integrity',
    'base',
    'group',
    'staleMaxAge',
  ];
  if (rule.varies !== undefined || unsupported.some((key) => cache[key] !== undefined)) {
    return 'skip-unsupported';
  }
  if (cache.swr === true || rule.isr !== undefined) {
    return cache.maxAge;
  }
  return undefined;
}

function queryPolicyFromIsr(value: unknown): RevalidateQueryPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const isr = value as Record<string, unknown>;
  if (Array.isArray(isr.allowQuery) && isr.allowQuery.every((entry) => typeof entry === 'string')) {
    return { allow: isr.allowQuery };
  }
  return isr.passQuery === true ? true : false;
}

function redirectFromNitroRule(source: string, rule: Record<string, unknown>): RedirectRule | null {
  const redirect = rule.redirect;
  if (!redirect) {
    return null;
  }
  if (typeof redirect === 'string') {
    return { source, destination: redirect, status: 302 };
  }
  if (typeof redirect === 'object' && !Array.isArray(redirect)) {
    const obj = redirect as Record<string, unknown>;
    const destination = obj.to ?? obj.location ?? obj.destination;
    const status = obj.statusCode ?? obj.status;
    if (typeof destination === 'string') {
      return {
        source,
        destination,
        status: typeof status === 'number' ? status : 302,
      };
    }
  }
  return null;
}

function fallbackFromNitroRule(
  pattern: string,
  rule: Record<string, unknown>,
): IsrFallbackRule | null {
  const fallback = rule.fallback;
  if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
    return null;
  }
  const obj = fallback as Record<string, unknown>;
  const result: IsrFallbackRule = { pattern };
  if (typeof obj.htmlAsset === 'string') {
    result.htmlAsset = obj.htmlAsset;
  }
  if (typeof obj.payloadAsset === 'string') {
    result.payloadAsset = obj.payloadAsset;
  }
  if (
    obj.payloadHeaders &&
    typeof obj.payloadHeaders === 'object' &&
    !Array.isArray(obj.payloadHeaders)
  ) {
    result.payloadHeaders = Object.fromEntries(
      Object.entries(obj.payloadHeaders as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }
  return result.htmlAsset || result.payloadAsset ? result : null;
}
