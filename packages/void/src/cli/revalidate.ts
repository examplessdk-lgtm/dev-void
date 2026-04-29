import type { RevalidateRule } from './types';

export type RevalidateConfig = number | Record<string, number> | Array<RevalidateRule>;

export function normalizeConfigRevalidate(config: RevalidateConfig): Array<RevalidateRule> {
  if (typeof config === 'number') {
    return [{ pattern: '*', ttl: config, query: false, kind: 'page', source: 'config' }];
  }
  if (Array.isArray(config)) {
    return config.map((rule) => ({
      ...rule,
      query: rule.query ?? false,
      kind: rule.kind ?? 'page',
      source: 'config',
    }));
  }
  return Object.entries(config).map(([pattern, ttl]) => ({
    pattern,
    ttl,
    query: false,
    kind: 'page',
    source: 'config',
  }));
}
