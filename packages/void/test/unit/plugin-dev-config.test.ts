import { describe, expect, it } from 'vite-plus/test';
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
  it('runs before other dev server plugins', () => {
    expect(devTriggerSecretGuardPlugin().enforce).toBe('pre');
  });
});
