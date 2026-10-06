import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { devTriggersHintPlugin } from '../../src/plugin-dev-triggers-hint.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-dev-hint-'));
  tempDirs.push(root);
  return root;
}

function fakeServer() {
  const httpServer = new EventEmitter() as EventEmitter & {
    address: () => { port: number };
  };
  httpServer.address = () => ({ port: 5173 });
  return { httpServer };
}

async function runConfigureServer(plugin: ReturnType<typeof devTriggersHintPlugin>) {
  const server = fakeServer();
  const hook = plugin.configureServer;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configureServer not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (fn as any)(server);
  server.httpServer.emit('listening');
  // afterReady defers via setTimeout(_, 100)
  await new Promise((r) => setTimeout(r, 150));
  return server;
}

describe('devTriggersHintPlugin', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('prints nothing when there are no crons or queues', async () => {
    const root = createTempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: false,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => false,
      }),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('prints a default-mode hint with curl examples when crons exist', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: false,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => false,
      }),
    );

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 1 cron');
    expect(output).toContain('/__void/scheduled');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
    expect(output).toContain('"cron":"0 * * * *"');
  });

  it('includes queues in the count and emits a queue curl example', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'a.ts'),
      'export const cron = "* * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(
      join(root, 'crons', 'b.ts'),
      'export const cron = "0 0 * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, 'queues', 'emails.ts'), 'export default async () => {};\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: false,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => false,
      }),
    );

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 2 crons and 1 queue');
    expect(output).toContain('/__void/queue');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
    expect(output).toContain('"queue":"emails"');
  });

  it('prints x-void-internal when .env defines __VOID_PROXY_TOKEN', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, '.env'), '__VOID_PROXY_TOKEN=local-proxy-token\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: false,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => false,
      }),
    );

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('x-void-internal: local-proxy-token');
    expect(output).not.toContain('x-void-dev-trigger: dev-token-test');
  });

  it('prints the dev-trigger token when the Worker declares secrets and skips the .env proxy token', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, '.env'), '__VOID_PROXY_TOKEN=local-proxy-token\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: false,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => true,
      }),
    );

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
    expect(output).not.toContain('x-void-internal');
  });

  it('prints curl examples in framework mode (same as default mode)', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(
      devTriggersHintPlugin(root, {
        framework: true,
        devTriggerToken: 'dev-token-test',
        workerDeclaresSecrets: () => false,
      }),
    );

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 1 cron');
    expect(output).toContain('/__void/scheduled');
    expect(output).toContain('x-void-dev-trigger: dev-token-test');
  });
});

describe('framework dev-triggers hint', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function svelteKitProject(cloudflare: Record<string, unknown>, typed: boolean): string {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { '@sveltejs/kit': '2.0.0' } }),
    );
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    writeFileSync(join(root, '.env'), '__VOID_PROXY_TOKEN=local-proxy-token\n');
    if (typed) {
      writeFileSync(
        join(root, 'void.config.ts'),
        `export default { cloudflare: ${JSON.stringify(cloudflare)} };\n`,
      );
    } else {
      writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify(cloudflare));
    }
    return root;
  }

  async function frameworkHint(root: string): Promise<string> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const plugins = voidPlugin();
    expect(plugins.some((plugin) => plugin.name === 'void:sveltekit-hooks-inject')).toBe(true);
    const hint = plugins.find((plugin) => plugin.name === 'void:dev-triggers-hint');
    if (!hint) {
      throw new Error('Expected framework dev-triggers hint');
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runConfigureServer(hint as ReturnType<typeof devTriggersHintPlugin>);
    return log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
  }

  for (const typed of [true, false]) {
    const source = typed ? 'void.config.ts' : 'wrangler.jsonc';

    it(`prints the dev-trigger token when ${source} declares secrets`, async () => {
      const output = await frameworkHint(
        svelteKitProject({ name: 'app', secrets: { required: ['API_KEY'] } }, typed),
      );
      expect(output).toContain('x-void-dev-trigger: ');
      expect(output).not.toContain('x-void-internal');
    });

    it(`prints the .env proxy token when ${source} declares no secrets`, async () => {
      const output = await frameworkHint(svelteKitProject({ name: 'app' }, typed));
      expect(output).toContain('x-void-internal: local-proxy-token');
    });
  }
});
