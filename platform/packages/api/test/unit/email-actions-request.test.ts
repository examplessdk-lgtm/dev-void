import { describe, expect, it, vi } from 'vite-plus/test';
import emailActions from '../../src/routes/internal-email-actions.ts';

describe('internal email action request bounds', () => {
  it('times out a stalled body without awaiting its cancellation', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      });
      const request = new Request('https://api/internal/email/actions/admit', {
        method: 'POST',
        headers: { 'x-void-internal': 'present' },
        body,
        duplex: 'half',
      } as RequestInit);
      const result = emailActions.request(request);
      await vi.advanceTimersByTimeAsync(5_001);
      const response = await result;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: 'action request timed out' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
