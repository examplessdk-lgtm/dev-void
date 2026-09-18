import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {},
}));

const worker = (await import('../../src/index.ts')).default;

describe('retired proxy email relay endpoint', () => {
  it('rejects before reading MIME or invoking a tenant', async () => {
    const dispatch = vi.fn();
    const read = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read();
          controller.enqueue(new TextEncoder().encode('From: sender@example.com\r\n\r\nsecret'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const env = {
      JWT_SECRET: 'test-secret',
      ROUTING: { get: vi.fn(async () => null) },
      DISPATCH: { get: dispatch },
    };
    const response = await worker.fetch(
      new Request('https://proxy.void.cloud/email/relay', {
        method: 'POST',
        body,
        duplex: 'half',
        headers: { 'content-type': 'message/rfc822' },
      } as RequestInit),
      env as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
