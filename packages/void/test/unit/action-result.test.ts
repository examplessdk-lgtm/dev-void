import { describe, expect, it, vi } from 'vitest';
import {
  VoidActionError,
  categorizeActionError,
  isAbortError,
  submitAction,
  type VoidRouter,
} from '../../src/pages/client';

function routerWithVisit(visit: VoidRouter['visit']): VoidRouter {
  return {
    _hoverDelay: 75,
    get url() {
      return new URL('http://localhost/');
    },
    get path() {
      return '/';
    },
    get query() {
      return new URLSearchParams();
    },
    visit,
    refresh: vi.fn(),
    prefetch: vi.fn(),
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
}

describe('action result handling', () => {
  it('categorizes expected client errors as call-site errors', () => {
    expect(categorizeActionError(400)).toBe('callSite');
    expect(categorizeActionError(404)).toBe('callSite');
    expect(categorizeActionError(409)).toBe('callSite');
    expect(categorizeActionError(422)).toBe('callSite');
    expect(categorizeActionError(429)).toBe('callSite');
  });

  it('categorizes auth and server errors as boundary errors', () => {
    expect(categorizeActionError(401)).toBe('boundary');
    expect(categorizeActionError(403)).toBe('boundary');
    expect(categorizeActionError(500)).toBe('boundary');
    expect(categorizeActionError(503)).toBe('boundary');
  });

  it('turns page validation errors into a call-site action result', async () => {
    const router = routerWithVisit(vi.fn(async () => ({ errors: { name: 'Required' } })));

    const result = await submitAction(router, '/users', { method: 'POST', data: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(422);
      expect(result.error.body).toEqual({ errors: { name: 'Required' } });
    }
  });

  it('returns call-site action errors instead of throwing them', async () => {
    const error = new VoidActionError({
      body: 'Missing',
      status: 404,
      statusText: 'Not Found',
      url: '/users/1',
    });
    const router = routerWithVisit(
      vi.fn(async () => {
        throw error;
      }),
    );

    const result = await submitAction(router, '/users/1', { method: 'DELETE' });

    expect(result).toEqual({ ok: false, error });
  });

  it('returns structurally equivalent call-site action errors', async () => {
    const error = {
      body: 'Conflict',
      message: 'Action failed with 409 Conflict',
      name: 'VoidActionError',
      status: 409,
      statusText: 'Conflict',
      url: '/users',
    } as VoidActionError;
    const router = routerWithVisit(
      vi.fn(async () => {
        throw error;
      }),
    );

    const result = await submitAction(router, '/users', { method: 'POST' });

    expect(result).toEqual({ ok: false, error });
  });

  it('throws structurally equivalent boundary action errors', async () => {
    const error = {
      body: 'Boom',
      message: 'Action failed with 500 Internal Server Error',
      name: 'VoidActionError',
      status: 500,
      statusText: 'Internal Server Error',
      url: '/users',
    } as VoidActionError;
    const router = routerWithVisit(
      vi.fn(async () => {
        throw error;
      }),
    );

    await expect(submitAction(router, '/users', { method: 'POST' })).rejects.toBe(error);
  });

  it('throws boundary action errors', async () => {
    const error = new VoidActionError({
      body: 'Boom',
      status: 500,
      statusText: 'Internal Server Error',
      url: '/users',
    });
    const router = routerWithVisit(
      vi.fn(async () => {
        throw error;
      }),
    );

    await expect(submitAction(router, '/users', { method: 'POST' })).rejects.toBe(error);
  });

  it('detects abort errors', () => {
    expect(isAbortError(new DOMException('Navigation aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('Boom'))).toBe(false);
  });
});
