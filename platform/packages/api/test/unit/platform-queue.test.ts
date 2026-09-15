import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { describe, expect, it, vi } from 'vite-plus/test';
import { processPlatformQueue } from '../../src/platform-queue.ts';

function batch(queue: string) {
  return {
    ackAll: vi.fn(),
    messages: [{ body: {}, id: 'message', timestamp: new Date() }],
    queue,
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    CRON_FIRES_QUEUE_NAME: 'cron',
    ROUTING: {
      get: vi.fn(async () => null),
    },
    ...overrides,
  };
}

function processors() {
  return {
    cron: vi.fn(async () => {}),
    usage: vi.fn(async () => {}),
  };
}

describe('platform queue lifecycle', () => {
  it('continues draining durable usage while the platform is disabled', async () => {
    const input = batch('usage');
    const bindings = env({
      PLATFORM_INSTALLATION_ID: 'installation-id',
      ROUTING: {
        get: vi.fn(async (key: string) => (key === PLATFORM_DISABLED_KEY ? 'disabled' : null)),
      },
    });
    const handlers = processors();

    await processPlatformQueue(input, bindings as never, handlers);

    expect(handlers.usage).toHaveBeenCalledOnce();
    expect(handlers.cron).not.toHaveBeenCalled();
    expect(bindings.ROUTING.get).not.toHaveBeenCalled();
    expect(input.ackAll).not.toHaveBeenCalled();
  });

  it('explicitly cancels and audits pending cron fires while disabled', async () => {
    const input = batch('cron');
    const bindings = env({
      PLATFORM_INSTALLATION_ID: 'installation-id',
      ROUTING: { get: vi.fn(async () => 'disabled') },
    });
    const handlers = processors();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processPlatformQueue(input, bindings as never, handlers);

    expect(input.ackAll).toHaveBeenCalledOnce();
    expect(handlers.cron).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('canceled 1 pending cron'));
    warning.mockRestore();
  });

  it('cancels staging cron fires without relying on routing KV', async () => {
    const input = batch('cron');
    const get = vi.fn(async () => {
      throw new Error('staging must fail closed before KV');
    });
    const bindings = env({
      PLATFORM_INSTALLATION_ID: 'installation-id',
      PLATFORM_TRAFFIC_STATE: 'staging',
      ROUTING: { get },
    });
    const handlers = processors();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processPlatformQueue(input, bindings as never, handlers);

    expect(input.ackAll).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
    expect(handlers.cron).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('keeps hosted Void Cloud cron delivery unchanged', async () => {
    const input = batch('cron');
    const bindings = env();
    const handlers = processors();

    await processPlatformQueue(input, bindings as never, handlers);

    expect(handlers.cron).toHaveBeenCalledOnce();
    expect(bindings.ROUTING.get).not.toHaveBeenCalled();
    expect(input.ackAll).not.toHaveBeenCalled();
  });
});
