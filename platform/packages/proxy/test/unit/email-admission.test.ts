import { describe, expect, it } from 'vite-plus/test';
import { emailPayloadDigest } from '../../src/email-admission.ts';

const encoder = new TextEncoder();
function message(date: string, id: string, boundary: string, body: string) {
  return encoder.encode(
    [
      `Date: ${date}`,
      'From: acme@mail.example.com',
      'To: recipient@example.com',
      'Subject: hello',
      `Message-ID: <${id}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
}

describe('email admission payload digest', () => {
  it('deduplicates retries when generated date, message ID and multipart boundary change', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'hello',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'hello',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
  });

  it('conflicts on changed message content and preserves boundary-like body text', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'hello =_void_mixed_AAAA',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'hello =_void_mixed_BBBB',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
    const c = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'changed',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], c),
    );
  });

  it('does not normalize a boundary declaration written as ordinary body text', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'literal boundary="=_void_mixed_body_A"',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'literal boundary="=_void_mixed_body_B"',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
  });
});
