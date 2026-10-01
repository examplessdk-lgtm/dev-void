import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { CloudEnv } from 'void/handler';

const mocks = vi.hoisted(() => ({ revalidate: vi.fn(), put: vi.fn() }));
vi.mock('void', async () => import('void/handler'));
vi.mock('void/isr', () => ({ revalidate: mocks.revalidate }));
vi.mock('void/kv', () => ({ kv: { put: mocks.put, get: vi.fn() } }));

import { action } from '../../../../../playground/kitchen-sink/pages/revalidate.server.ts';

const app = new Hono<CloudEnv>()
  .post('/', async (c) => {
    const response = await action(c);
    return response instanceof Response ? response : c.body(null, 204);
  })
  .onError((error) => Response.json({ error: error.message }, { status: 502 }));

beforeEach(() => {
  mocks.revalidate.mockReset();
  mocks.put.mockReset();
});

describe('kitchen-sink ISR revalidation', () => {
  it('reports a rejected purge instead of storing a successful revalidation timestamp', async () => {
    mocks.revalidate.mockRejectedValue(new Error('provider purge failed'));
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'provider purge failed' });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('records success after the purge completes', async () => {
    const response = await app.request('/', { method: 'POST' });
    expect(response.status).toBe(204);
    expect(mocks.revalidate).toHaveBeenCalledWith({ paths: ['/revalidate'] });
    expect(mocks.put).toHaveBeenCalledWith('revalidate:last', expect.any(String));
    expect(mocks.put.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.revalidate.mock.invocationCallOrder[0],
    );
  });
});
