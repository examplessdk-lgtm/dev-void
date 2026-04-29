import { describe, it, expect, vi } from 'vitest';

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
import { applyDeployEvent } from '../../src/cli/deploy.ts';
import type { DeployEvent } from '../../src/cli/types.ts';

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
