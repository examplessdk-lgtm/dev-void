import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  nitroDevTriggerInjectPlugin,
} from '../../src/plugin-framework-triggers.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-fw-triggers-'));
  tempDirs.push(root);
  return root;
}

function callConfigResolved(plugin: ReturnType<typeof frameworkTriggersPlugin>) {
  const hook = plugin.configResolved;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configResolved not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)({} as never);
}

function callConfigureServer(
  plugin:
    | ReturnType<typeof nitroDevTriggerInjectPlugin>
    | ReturnType<typeof astroDevTriggerInjectPlugin>,
) {
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configureServer not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)({ httpServer: { once() {} } });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('frameworkTriggersPlugin', () => {
  it('writes a dispatch module that imports each cron and queue handler', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(
      join(root, 'crons', 'b.ts'),
      'export const cron = "*/5 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, 'queues', 'emails.ts'), 'export default async () => {};\n');

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'dev-token-test' });
    callConfigResolved(plugin);

    const generated = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');
    expect(generated).toContain('@ts-nocheck');
    expect(generated).toContain(`__DEV_TRIGGER_TOKEN = "dev-token-test"`);
    expect(generated).toContain(`from "${root}/crons/a.ts"`);
    expect(generated).toContain(`from "${root}/crons/b.ts"`);
    expect(generated).toContain(`from "${root}/queues/emails.ts"`);
    expect(generated).toContain('"0 * * * *"');
    expect(generated).toContain('export async function handleDevTrigger');
  });

  it('emits handleDevTrigger that returns null for non-trigger requests', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'tk' });
    callConfigResolved(plugin);
    const code = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');

    expect(code).toMatch(
      /url\.pathname !== "\/__void\/scheduled"\s*&&\s*url\.pathname !== "\/__void\/queue"/,
    );
    expect(code).toContain('return null');
  });

  it('rejects requests with no auth headers', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );

    const plugin = frameworkTriggersPlugin(root, { devTriggerToken: 'tk' });
    callConfigResolved(plugin);
    const code = readFileSync(frameworkTriggersDispatchPath(root), 'utf-8');
    expect(code).toContain('"unauthorized"');
    expect(code).toContain('x-void-internal');
    expect(code).toContain('x-void-dev-trigger');
  });
});

describe('nitroDevTriggerInjectPlugin', () => {
  it('writes Nuxt middleware to <root>/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf-8');
    expect(code).toContain('@ts-nocheck');
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
    expect(code).toContain('event.context?.cloudflare');
    expect(code).toContain('event.node.req');
  });

  it('writes Analog middleware to <root>/src/server/middleware/', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'src/server' });
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'server', 'middleware', '__void-dev-trigger.ts');
    expect(existsSync(middlewarePath)).toBe(true);
  });

  it('appends middleware path to .gitignore', () => {
    const root = createTempRoot();
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('server/middleware/__void-dev-trigger.ts');
  });

  it('does not duplicate the .gitignore line on repeat invocations', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, '.gitignore'),
      'node_modules\nserver/middleware/__void-dev-trigger.ts\n',
    );
    const plugin = nitroDevTriggerInjectPlugin(root, { serverDir: 'server' });
    callConfigureServer(plugin);

    const gitignore = readFileSync(join(root, '.gitignore'), 'utf-8');
    const occurrences = gitignore
      .split('\n')
      .filter((l) => l.trim() === 'server/middleware/__void-dev-trigger.ts').length;
    expect(occurrences).toBe(1);
  });
});

describe('astroDevTriggerInjectPlugin', () => {
  it('writes src/middleware.ts when no user middleware exists', () => {
    const root = createTempRoot();
    const plugin = astroDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    const middlewarePath = join(root, 'src', 'middleware.ts');
    expect(existsSync(middlewarePath)).toBe(true);
    const code = readFileSync(middlewarePath, 'utf-8');
    expect(code).toContain("from 'cloudflare:workers'");
    expect(code).toContain(`from "${frameworkTriggersDispatchPath(root)}"`);
  });

  it('warns and skips when src/middleware.ts already exists', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    const existing = '// user middleware\nexport const onRequest = () => {};\n';
    writeFileSync(join(root, 'src', 'middleware.ts'), existing);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const plugin = astroDevTriggerInjectPlugin(root);
    callConfigureServer(plugin);

    // User file untouched
    expect(readFileSync(join(root, 'src', 'middleware.ts'), 'utf-8')).toBe(existing);
    // Warned
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Astro middleware already exists',
    );
  });
});
