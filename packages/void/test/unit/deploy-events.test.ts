import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  cancel: vi.fn(),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import type { SpinnerResult } from '@clack/prompts';
import {
  applyDeployEvent,
  streamDeployEvents,
  warnIgnoredNotFoundForFramework,
  warnUnpublishedRouting,
} from '../../src/cli/deploy.ts';
import type { CliLogger } from '../../src/cli/log-file.ts';
import type { DeployEvent } from '../../src/cli/types.ts';

type DoneEvent = Extract<DeployEvent, { event: 'done' }>;

function createMockCliLog() {
  const calls = {
    info: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    warn: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
    error: [] as Array<{ msg: string }>,
  };
  const logger: CliLogger = {
    info: (msg, fields) => {
      calls.info.push({ msg, fields });
    },
    warn: (msg, fields) => {
      calls.warn.push({ msg, fields });
    },
    error: (msg) => {
      calls.error.push({ msg });
    },
    debug: () => {},
    path: null,
    close: async () => {},
  };
  return { logger, calls };
}

async function* eventsOf(events: ReadonlyArray<DeployEvent>): AsyncGenerator<DeployEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockSpinner() {
  const calls = {
    start: [] as Array<unknown>,
    stop: [] as Array<unknown>,
    message: [] as Array<unknown>,
  };
  return {
    spinner: {
      start: (m?: unknown) => {
        calls.start.push(m);
      },
      stop: (m?: unknown) => {
        calls.stop.push(m);
      },
      message: (m?: unknown) => {
        calls.message.push(m);
      },
    } as unknown as SpinnerResult,
    calls,
  };
}

describe('applyDeployEvent', () => {
  it('shows queue_setup progress message so the user sees it mid-deploy', async () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'queue_setup', queues: ['emails', 'jobs'] } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'continue' });
    expect(calls.message).toHaveLength(1);
    expect(String(calls.message[0])).toMatch(/emails/);
    expect(String(calls.message[0])).toMatch(/jobs/);
  });

  it('logs a persistent warning for queue_consumer_conflict instead of a transient spinner message', async () => {
    const { spinner, calls } = createMockSpinner();
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    const result = applyDeployEvent(
      {
        event: 'queue_consumer_conflict',
        queue: 'emails',
        ownerScript: 'other-dispatch',
      } satisfies DeployEvent,
      spinner,
    );

    expect(result).toEqual({ kind: 'continue' });
    // Warning must use log.warn (persists above the spinner) so the user sees
    // it after deploy completes — NOT s.message (gets overwritten).
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/emails/);
    expect(msg).toMatch(/other-dispatch/);
    expect(calls.message).toHaveLength(0);
  });

  it('returns {kind:"start"} with deploymentId so the caller can capture it', () => {
    const { spinner } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'start', deploymentId: 'dpl_abc' } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'start', deploymentId: 'dpl_abc' });
  });

  it('shows worker readiness before migration execution starts', () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent({ event: 'worker_readiness' } satisfies DeployEvent, spinner);
    expect(result).toEqual({ kind: 'continue' });
    expect(calls.message[0]).toBe('Waiting for worker to become reachable...');
  });

  it('returns {kind:"done"} for done event and stops the spinner', () => {
    const { spinner, calls } = createMockSpinner();
    const done: Extract<DeployEvent, { event: 'done' }> = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
    };
    const result = applyDeployEvent(done, spinner);
    expect(result).toEqual({ kind: 'done', event: done });
    expect(calls.stop[0]).toBe('Deployed!');
  });

  it('keeps the "Deployed!" message when published is true', () => {
    const { spinner, calls } = createMockSpinner();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      published: true,
    };
    const result = applyDeployEvent(done, spinner);
    expect(result).toEqual({ kind: 'done', event: done });
    expect(calls.stop[0]).toBe('Deployed!');
  });

  it('degrades the done message when published is false but still resolves as a committed done', () => {
    const { spinner, calls } = createMockSpinner();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      published: false,
    };
    const result = applyDeployEvent(done, spinner);
    // Committed-live: still a `done` kind, NOT an error.
    expect(result).toEqual({ kind: 'done', event: done });
    const msg = String(calls.stop[0]);
    expect(msg).toMatch(/routing was not published/i);
    expect(msg).not.toBe('Deployed!');
  });

  it('returns {kind:"error"} for error event', () => {
    const { spinner, calls } = createMockSpinner();
    const result = applyDeployEvent(
      { event: 'error', message: 'bad things', step: 'worker_upload' } satisfies DeployEvent,
      spinner,
    );
    expect(result).toEqual({ kind: 'error', message: 'bad things' });
    expect(calls.stop[0]).toBe('Deploy failed');
  });
});

describe('streamDeployEvents', () => {
  it('logs deploy_success and returns the done event on a published deploy', async () => {
    const { spinner } = createMockSpinner();
    const { logger, calls } = createMockCliLog();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
    };

    const result = await streamDeployEvents(
      'proj_1',
      eventsOf([{ event: 'start', deploymentId: 'dpl_1' }, done]),
      spinner,
      logger,
    );

    expect(result).toEqual(done);
    const keys = calls.info.map((c) => c.msg);
    expect(keys).toContain('deploy_success');
    expect(keys).not.toContain('deploy_degraded');
    const success = calls.info.find((c) => c.msg === 'deploy_success');
    expect(success?.fields?.degraded).toBe(false);
  });

  it('logs deploy_degraded (not deploy_success) and still returns the committed done event when published is false', async () => {
    const { spinner } = createMockSpinner();
    const { logger, calls } = createMockCliLog();
    const done: DoneEvent = {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      published: false,
    };

    const result = await streamDeployEvents(
      'proj_1',
      eventsOf([{ event: 'start', deploymentId: 'dpl_1' }, done]),
      spinner,
      logger,
    );

    // Resolves as a committed deploy — no throw, returns the done event.
    expect(result).toEqual(done);
    const keys = calls.info.map((c) => c.msg);
    expect(keys).toContain('deploy_degraded');
    expect(keys).not.toContain('deploy_success');
    const degraded = calls.info.find((c) => c.msg === 'deploy_degraded');
    expect(degraded?.fields?.degraded).toBe(true);
  });
});

describe('warnUnpublishedRouting', () => {
  function makeDone(published?: boolean): DoneEvent {
    return {
      event: 'done',
      deployment: 'dpl_1',
      url: 'https://app.void.app',
      urls: ['https://app.void.app'],
      assets: 0,
      workers: 1,
      ...(published === undefined ? {} : { published }),
    };
  }

  it('warns persistently when routing was not published', async () => {
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnUnpublishedRouting(makeDone(false));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/routing was not published/i);
  });

  it('does not warn when published is true or omitted', async () => {
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;

    warnSpy.mockClear();
    warnUnpublishedRouting(makeDone(true));
    warnUnpublishedRouting(makeDone(undefined));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// Class B/C framework deploys pin `not_found_handling: 'none'` and never read
// `routing.notFound`. The config validator accepts the key in every mode, so
// without this warning the option looks supported and silently does nothing.
describe('warnIgnoredNotFoundForFramework', () => {
  it('warns, naming the framework and the pinned value, when routing.notFound is set', async () => {
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnIgnoredNotFoundForFramework('404-page', 'astro');

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain('"routing.notFound"');
    expect(msg).toContain('astro');
    expect(msg).toContain('"none"');
    expect(msg).toMatch(/ignored/i);
  });

  it('warns for every accepted value, including the pinned one', async () => {
    // Even `'none'` warns: it happens to match what the path pins, but the key
    // is still not read, and staying silent there would teach that it works.
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;

    for (const value of ['single-page-application', '404-page', 'none'] as const) {
      warnSpy.mockClear();
      warnIgnoredNotFoundForFramework(value, 'sveltekit');
      expect(warnSpy).toHaveBeenCalledOnce();
    }
  });

  it('does not warn when routing.notFound is unset', async () => {
    const { log } = await import('@clack/prompts');
    const warnSpy = log.warn as ReturnType<typeof vi.fn>;
    warnSpy.mockClear();

    warnIgnoredNotFoundForFramework(undefined, 'nuxt');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
