import type { Plugin } from 'vite';

/** Stand-in for `@cloudflare/vite-plugin`: exposes the options Void passes as `api.pluginConfig`. */
export function cloudflare(pluginConfig: unknown): Array<Plugin> {
  return [{ name: 'mock:cloudflare', api: { pluginConfig } }];
}
