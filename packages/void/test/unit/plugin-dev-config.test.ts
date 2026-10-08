import { describe, expect, it, vi } from 'vite-plus/test';
import {
  devTriggerSecretGuardPlugin,
  isDevTriggerSecretRequest,
} from '../../src/plugin-dev-config.ts';

describe('isDevTriggerSecretRequest', () => {
  it.each([
    '/.void/dev-trigger-token',
    '/.VOID/Dev-Trigger-Token',
    '/.void/./dev-trigger-token',
    '/.void//dev-trigger-token',
    '/.void/x/../dev-trigger-token',
    '/%2evoid/dev-trigger-token',
    '/%252evoid/dev-trigger-token',
    '/.void%2fdev-trigger-token',
    '/.void%5cdev-trigger-token',
    '/.void./dev-trigger-token',
    '/.void/dev-trigger-token.',
    '/.void/dev-trigger-token?raw',
    '/.void/dev-trigger-token%',
    '/@fs/Users/me/app/.void/dev-trigger-token',
    '/_nuxt/.void/dev-trigger-token',
    '/.void/dev-triggers.ts?import',
    '/@id/.void/dev-triggers.ts',
    '/_nuxt/@fs/Users/me/app/.nuxt/dev/index.mjs',
    '/_nuxt/@fs/Users/me/app/.nuxt/dev/index.mjs.map',
    '/dist/.nitro/dev/index.mjs',
    '/@fs/Users/me/app/dist/.nitro/dev/index.mjs.map',
    '\\.void\\dev-trigger-token',
    '/.astro/dev.log',
    '/.ASTRO/Dev.Log?raw',
    '/@fs/Users/me/app/.astro/dev.log',
    '/.void/drizzle.config.json',
    '/.VOID/Drizzle.Config.json',
    '/%2evoid/drizzle.config.json',
    '/@fs/Users/me/app/.void/drizzle.config.json',
    '/.void/drizzle.config.json?raw',
  ])('refuses %s', (url) => {
    expect(isDevTriggerSecretRequest(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '/',
    '/src/main.ts',
    '/.void/entry.ts',
    '/.void/routes.d.ts',
    '/__void/inbox?token=abc',
    '/__void/scheduled',
    '/api/__void/cron-trigger',
    '/void/dev-trigger-token',
    '/.voidx/dev-trigger-token',
    '/_nuxt/.nuxt/components.plugin.mjs',
    '/_nuxt/@fs/Users/me/app/.nuxt/devtools/x.mjs',
    '/dist/.nitro/types/nitro.d.ts',
    '/.astro/dev.json',
    '/.astro/content.d.ts',
    '/drizzle.config.json',
    '/.void/drizzle.config.ts',
    '/?q=/.void/dev-trigger-token',
    '/@vite/client',
  ])('allows %s', (url) => {
    expect(isDevTriggerSecretRequest(url)).toBe(false);
  });
});

describe('devTriggerSecretGuardPlugin', () => {
  type Middleware = (req: { url?: string }, res: unknown, next: () => void) => void;

  function installGuard(): Middleware {
    const plugin = devTriggerSecretGuardPlugin();
    let middleware: Middleware | undefined;
    const server = {
      middlewares: {
        use(fn: Middleware) {
          middleware = fn;
        },
      },
    };
    (plugin.configureServer as (this: unknown, s: unknown) => void).call(plugin, server);
    if (!middleware) {
      throw new Error('Expected the guard to register a middleware.');
    }
    return middleware;
  }

  it('runs before other dev server plugins and only in serve', () => {
    const plugin = devTriggerSecretGuardPlugin();
    expect(plugin.apply).toBe('serve');
    expect(plugin.enforce).toBe('pre');
  });

  it('answers 404 for the token file without calling the next middleware', () => {
    const guard = installGuard();
    const res = { statusCode: 200, end: vi.fn() };
    const next = vi.fn();
    guard({ url: '/.void/dev-trigger-token' }, res, next);
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes other requests through untouched', () => {
    const guard = installGuard();
    const res = { statusCode: 200, end: vi.fn() };
    const next = vi.fn();
    guard({ url: '/src/main.ts' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.end).not.toHaveBeenCalled();
  });
});
