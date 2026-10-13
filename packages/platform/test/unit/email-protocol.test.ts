import { describe, expect, it } from 'vite-plus/test';
import {
  EMAIL_MAX_INBOUND_BYTES,
  EMAIL_MAX_RESPONSE_BYTES,
  encodeEmailActions,
  encodeEmailEnvelope,
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

  it('reads a small envelope split across the length prefix, metadata and MIME', async () => {
    const raw = new TextEncoder().encode('From: sender@example.com\r\n\r\nhello');
    const envelope = {
      from: 'sender@example.com',
      to: 'support@example.com',
      headers: { from: 'sender@example.com' },
      raw,
      rawSize: raw.byteLength,
    };
    const encoded = encodeEmailEnvelope(envelope);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.byteLength; offset += 3) {
          controller.enqueue(encoded.subarray(offset, offset + 3));
        }
        controller.close();
      },
    });
    expect(await readEmailEnvelope(stream)).toEqual(envelope);
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

  it('enforces the MIME limit independently of unused metadata capacity', async () => {
    const metadata = new TextEncoder().encode(
      JSON.stringify({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        headers: {},
        rawSize: EMAIL_MAX_INBOUND_BYTES + 1,
      }),
    );
    const bytes = new Uint8Array(4 + metadata.byteLength + EMAIL_MAX_INBOUND_BYTES + 1);
    new DataView(bytes.buffer).setUint32(0, metadata.byteLength);
    bytes.set(metadata, 4);
    await expect(
      readEmailEnvelope(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      ),
    ).rejects.toThrow('invalid email envelope');
  });

  it('includes the terminal frame in the aggregate action limit', async () => {
    const address = { from: 'a@b', to: 'c@d' };
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({ type: 'reply', ...address }),
    ).byteLength;
    const first = new Uint8Array(5 * 1024 * 1024);
    const secondSize = EMAIL_MAX_RESPONSE_BYTES - 5 - 2 * (10 + metadataBytes) - first.byteLength;
    const action = (raw: Uint8Array) => ({ type: 'reply' as const, ...address, raw });
    const fitting = [action(first), action(new Uint8Array(secondSize))];
    expect(await readEmailActions(encodeEmailActions(fitting))).toHaveLength(2);
    await expect(
      readEmailActions(encodeEmailActions([action(first), action(new Uint8Array(secondSize + 1))])),
    ).rejects.toThrow('email actions too large');
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

  it('does not extend protocol deadlines while an uncooperative stream cancels', async () => {
    const uncooperative = () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          return new Promise<void>(() => {});
        },
      });

    await expect(readEmailActions(uncooperative(), 5)).rejects.toThrow('email response timeout');
    await expect(readEmailEnvelope(uncooperative(), 5)).rejects.toThrow('email envelope timeout');
  });
});
