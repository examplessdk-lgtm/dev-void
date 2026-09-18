import { describe, expect, it } from 'vite-plus/test';
import {
  encodeEmailActions,
  readEmailEnvelope,
  readEmailActions,
  signEmailReceipt,
  verifyEmailReceipt,
} from '../../src/email-protocol.ts';

const claims = {
  version: 1 as const,
  receiptId: 'a16b6d96-7097-45f6-b88e-5677072628ef',
  projectId: 'project-1',
  deploymentId: 'deployment-1',
  recipient: 'support@example.com',
  expiresAt: Date.now() + 20_000,
};

describe('bounded email receipt protocol', () => {
  it('binds a short-lived receipt to project, deployment and SMTP recipient', async () => {
    const token = await signEmailReceipt(claims, 'platform-only-secret');
    expect(await verifyEmailReceipt(token, 'platform-only-secret', claims)).toMatchObject(claims);
    expect(await verifyEmailReceipt(token, 'tenant-known-token', claims)).toBeNull();
    expect(
      await verifyEmailReceipt(token, 'platform-only-secret', {
        ...claims,
        recipient: 'other@example.com',
      }),
    ).toBeNull();
    expect(
      await verifyEmailReceipt(token, 'platform-only-secret', claims, claims.expiresAt + 1),
    ).toBeNull();
  });

  it('reads a complete framed batch before returning actions', async () => {
    const stream = encodeEmailActions([
      { type: 'forward', to: 'user@example.com' },
      {
        type: 'reply',
        from: 'support@example.com',
        to: 'sender@example.com',
        raw: new Uint8Array([0, 255, 17]),
      },
    ]);
    expect(await readEmailActions(stream)).toEqual([
      { type: 'forward', to: 'user@example.com' },
      {
        type: 'reply',
        from: 'support@example.com',
        to: 'sender@example.com',
        raw: new Uint8Array([0, 255, 17]),
      },
    ]);
  });

  it('rejects a truncated tail instead of returning a partial action batch', async () => {
    const encoded = encodeEmailActions([{ type: 'forward', to: 'user@example.com' }]);
    const reader = encoded.getReader();
    const first = await reader.read();
    const truncated = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first.value!);
        controller.close();
      },
    });
    await expect(readEmailActions(truncated)).rejects.toThrow('truncated email response');
  });

  it('rejects oversized metadata before JSON parsing', async () => {
    const head = new Uint8Array(5);
    new DataView(head.buffer).setUint32(0, 8193);
    head[4] = 1;
    await expect(
      readEmailActions(
        new ReadableStream({
          start(controller) {
            controller.enqueue(head);
            controller.close();
          },
        }),
      ),
    ).rejects.toThrow('invalid email action frame');
  });

  it('rejects an oversized tenant response before retaining its chunk', async () => {
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    await expect(
      readEmailActions(
        new ReadableStream({
          start(controller) {
            controller.enqueue(oversized);
            controller.close();
          },
        }),
      ),
    ).rejects.toThrow('email response too large');
  });

  it('bounds stalled tenant and envelope streams by deadline', async () => {
    await expect(readEmailActions(new ReadableStream<Uint8Array>(), 5)).rejects.toThrow(
      'email response timeout',
    );
    const envelope = new ReadableStream<Uint8Array>();
    await expect(readEmailEnvelope(envelope, 5)).rejects.toThrow('email envelope timeout');
  });
});
