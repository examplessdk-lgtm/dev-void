import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    await runConfigureServer(devTriggersHintPlugin(root, { framework: false }));
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

    await runConfigureServer(devTriggersHintPlugin(root, { framework: false }));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 1 cron');
    expect(output).toContain('/__void/scheduled');
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

    await runConfigureServer(devTriggersHintPlugin(root, { framework: false }));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('Detected 2 crons and 1 queue');
    expect(output).toContain('/__void/queue');
    expect(output).toContain('"queue":"emails"');
  });

  it('warns about missing dev support in framework mode', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    writeFileSync(
      join(root, 'crons', 'heartbeat.ts'),
      'export const cron = "0 * * * *";\nexport default async () => {};\n',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(devTriggersHintPlugin(root, { framework: true }));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('not yet supported in framework mode');
    expect(output).not.toContain('/__void/scheduled');
  });

  it('counts queues in the framework-mode warning without emitting endpoints', async () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(join(root, 'queues', 'emails.ts'), 'export default async () => {};\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runConfigureServer(devTriggersHintPlugin(root, { framework: true }));

    const output = log.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('1 queue');
    expect(output).toContain('not yet supported in framework mode');
    expect(output).not.toContain('/__void/queue');
  });
});
