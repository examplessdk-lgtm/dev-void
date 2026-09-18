import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { guardHumanStream } from '../../src/human-stream.ts';

afterEach(() => vi.useRealTimers());
describe('human authenticated streams', () => {
  it('checks every delivered chunk and cancels upstream after session revocation', async () => {
    let valid = true;
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const validate = vi.fn(async () => valid);
    const reader = guardHumanStream(source, validate).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    valid = false;
    await expect(reader.read()).rejects.toThrow('revoked');
    expect(validate).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('closes an idle stream when its authoritative session check fails', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const reader = guardHumanStream(new ReadableStream({ cancel }), async () => false).getReader();
    const rejected = expect(reader.read()).rejects.toThrow('revoked');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed on authority errors and cleans up on client cancellation', async () => {
    const cancel = vi.fn();
    const reader = guardHumanStream(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
      async () => {
        throw new Error('database unavailable');
      },
    ).getReader();
    await expect(reader.read()).rejects.toThrow('revoked');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
