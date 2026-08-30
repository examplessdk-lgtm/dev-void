import { describe, expect, it } from 'vitest';
import { buildMime, MimeError, normalizeEmail } from '../../src/runtime/email/mime.ts';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function build(opts: Parameters<typeof normalizeEmail>[0]) {
  const email = await normalizeEmail(opts);
  const { raw, messageId } = buildMime(email);
  return { raw, messageId, text: decode(raw) };
}

describe('normalizeEmail', () => {
  it('parses string addresses with display names', async () => {
    const email = await normalizeEmail({
      from: 'Acme <hello@acme.dev>',
      to: 'user@example.com',
      subject: 'Welcome',
      text: 'Hi',
    });
    expect(email.from).toEqual({ email: 'hello@acme.dev', name: 'Acme' });
    expect(email.to).toEqual([{ email: 'user@example.com' }]);
  });

  it('parses object addresses', async () => {
    const email = await normalizeEmail({
      from: { email: 'a@x.dev', name: 'A' },
      to: { email: 'b@y.dev' },
      subject: 's',
      text: 't',
    });
    expect(email.from).toEqual({ email: 'a@x.dev', name: 'A' });
  });

  it('accepts arrays for to/cc/bcc', async () => {
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: ['b@y.dev', { email: 'c@y.dev', name: 'C' }],
      cc: 'd@y.dev',
      bcc: ['e@y.dev'],
      subject: 's',
      text: 't',
    });
    expect(email.to).toHaveLength(2);
    expect(email.cc).toHaveLength(1);
    expect(email.bcc).toHaveLength(1);
  });

  it('rejects missing text and html', async () => {
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's' }),
    ).rejects.toBeInstanceOf(MimeError);
  });

  it('rejects empty to list', async () => {
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: [], subject: 's', text: 't' }),
    ).rejects.toThrow(/'to'/);
  });

  it('rejects malformed addresses', async () => {
    await expect(
      normalizeEmail({ from: 'no-at-sign', to: 'b@y.dev', subject: 's', text: 't' }),
    ).rejects.toThrow(/from/);
  });

  it('rejects CRLF in subject', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 'X\r\nBcc: attacker@evil.dev',
        text: 't',
      }),
    ).rejects.toThrow(/subject/);
  });

  it('rejects CRLF in custom header values', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { 'X-Campaign': 'welcome\r\nBcc: attacker@evil.dev' },
      }),
    ).rejects.toThrow(/X-Campaign/);
  });

  it('rejects invalid header names', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { 'X-Bad\r\nInjected': 'v' },
      }),
    ).rejects.toThrow(/header name/);
  });

  it('rejects CRLF in address email', async () => {
    await expect(
      normalizeEmail({
        from: { email: 'a@x.dev\r\nBcc: attacker@evil.dev', name: 'A' },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('rejects CRLF in display name', async () => {
    await expect(
      normalizeEmail({
        from: { email: 'a@x.dev', name: 'A\r\nBcc: attacker@evil.dev' },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('rejects CRLF in attachment filename', async () => {
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: 'evil.txt\r\nX-Injected: 1', content: 'x' }],
      }),
    ).rejects.toThrow(/filename/);
  });

  it('rejects whitespace inside an address', async () => {
    await expect(
      normalizeEmail({ from: 'a b@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
    ).rejects.toThrow(/from/);
  });
});

describe('buildMime', () => {
  it('builds a plain text/plain message', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'Hello',
      text: 'Hi there',
    });
    expect(text).toContain('From: a@x.dev');
    expect(text).toContain('To: b@y.dev');
    expect(text).toContain('Subject: Hello');
    expect(text).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(text).toContain('Hi there');
    expect(text).toMatch(/Message-ID: <[^@]+@x\.dev>/);
  });

  it('emits multipart/alternative when both text and html are set', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'Hi',
      text: 'plain',
      html: '<p>html</p>',
    });
    expect(text).toContain('Content-Type: multipart/alternative;');
    expect(text).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(text).toContain('Content-Type: text/html; charset=UTF-8');
    expect(text).toContain('plain');
    expect(text).toContain('<p>html</p>');
  });

  it('encodes non-ASCII display names as RFC 2047 encoded-words', async () => {
    const { text } = await build({
      from: { email: 'j@x.dev', name: 'Jürgen Müller' },
      to: 'b@y.dev',
      subject: '日本語',
      text: 'hi',
    });
    expect(text).toMatch(/From: =\?UTF-8\?B\?[^?]+\?= <j@x\.dev>/);
    expect(text).toMatch(/Subject: =\?UTF-8\?B\?[^?]+\?=/);
  });

  it('quoted-prints non-ASCII bodies', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'café',
    });
    expect(text).toContain('Content-Transfer-Encoding: quoted-printable');
    // 'é' = 0xC3 0xA9 in UTF-8 → =C3=A9
    expect(text).toContain('caf=C3=A9');
  });

  it('attaches files as base64 in multipart/mixed', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      attachments: [
        {
          filename: 'hello.txt',
          content: 'hello world',
          contentType: 'text/plain',
        },
      ],
    });
    expect(text).toContain('Content-Type: multipart/mixed;');
    expect(text).toContain('Content-Disposition: attachment; filename="hello.txt"');
    expect(text).toContain('Content-Transfer-Encoding: base64');
    expect(text).toContain(btoa('hello world'));
  });

  it('renders cc, replyTo, and custom headers', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      cc: 'c@y.dev',
      bcc: 'd@y.dev',
      replyTo: 'r@x.dev',
      headers: { 'X-Campaign': 'welcome' },
      subject: 's',
      text: 'hi',
    });
    expect(text).toContain('Cc: c@y.dev');
    expect(text).toContain('Reply-To: r@x.dev');
    expect(text).toContain('X-Campaign: welcome');
    // Bcc must NOT appear in the rendered MIME — every recipient receives the
    // same raw body, so a Bcc header would expose the BCC list.
    expect(text).not.toContain('Bcc:');
    expect(text).not.toContain('d@y.dev');
  });

  it('drops user-supplied reserved headers', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      headers: { 'Content-Type': 'text/evil', From: 'spoof@x.dev' },
    });
    expect(text).not.toContain('text/evil');
    expect(text).not.toContain('spoof@x.dev');
  });

  it('uses multipart/related for inline attachments alongside html', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      html: '<img src="cid:logo">',
      attachments: [
        {
          filename: 'logo.png',
          content: new Uint8Array([1, 2, 3]),
          contentType: 'image/png',
          contentId: 'logo',
          disposition: 'inline',
        },
      ],
    });
    expect(text).toContain('Content-Type: multipart/related;');
    expect(text).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(text).toContain('Content-ID: <logo>');
  });

  it('rejects oversized messages', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: big,
    });
    expect(() => buildMime(email)).toThrow(/exceeds Cloudflare limit/);
  });

  it('quotes display names containing RFC 5322 specials (comma is the worst)', async () => {
    // Comma in a name MUST be quoted — without quotes it splits the
    // address-list field. Pre-fix, the formatAddress fallback emitted
    // unquoted ASCII names, letting `Smith, John` corrupt the To header.
    const { text } = await build({
      from: { email: 'a@x.dev', name: 'Smith, John' },
      to: { email: 'b@y.dev', name: 'Doe; Jane' },
      subject: 's',
      text: 'hi',
    });
    expect(text).toContain('From: "Smith, John" <a@x.dev>');
    expect(text).toContain('To: "Doe; Jane" <b@y.dev>');
  });

  it('quotes display names containing parens, angles, colons', async () => {
    const cases: Array<[string, string]> = [
      ['Acme (US)', '"Acme (US)"'],
      ['<spoof>', '"<spoof>"'],
      ['phone: x', '"phone: x"'],
    ];
    for (const [name, expected] of cases) {
      const { text } = await build({
        from: { email: 'a@x.dev', name },
        to: 'b@y.dev',
        subject: 's',
        text: 'hi',
      });
      expect(text).toContain(`From: ${expected} <a@x.dev>`);
    }
  });

  it('escapes embedded quotes and backslashes in quoted display names', async () => {
    const { text } = await build({
      from: { email: 'a@x.dev', name: 'Smith, "Bob" \\Bobby' },
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
    });
    // Backslash is escaped first (`\` → `\\`), then quotes are escaped
    // (`"` → `\"`). Order matters; reverse order would double-escape the
    // backslash from the quote-escape into `\\\\\"`.
    expect(text).toContain('From: "Smith, \\"Bob\\" \\\\Bobby" <a@x.dev>');
  });

  it('rejects bare addr-spec values containing a comma (header-injection guard)', async () => {
    // Without this guard, `to: "victim@a.com,attacker@b.com"` slips
    // through the unquoted addr-spec path and renders as two recipients.
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'victim@example.com,attacker@evil.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/to/);
  });

  it('rejects bare addr-spec containing semicolon, angle, or quotes', async () => {
    for (const bad of ['a@x.dev;b@evil.dev', 'a@x.dev<b@evil.dev>', '"weird"@x.dev']) {
      await expect(
        normalizeEmail({ from: bad, to: 'b@y.dev', subject: 's', text: 't' }),
      ).rejects.toThrow(/from/);
    }
  });

  it('rejects unbalanced quotes around display name', async () => {
    // Pre-fix the parser had two independent optional quotes, so a
    // single stray `"` slipped through.
    await expect(
      normalizeEmail({
        from: '"Acme <a@x.dev>',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/from/);
  });

  it('drops user-supplied In-Reply-To and References (reserved for replyEmail)', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: {
        'In-Reply-To': '<spoof-thread@evil.dev>',
        References: '<spoof-references@evil.dev>',
      },
    });
    expect(text).not.toContain('spoof-thread');
    expect(text).not.toContain('spoof-references');
  });

  it('folds long whitespace-separated headers (e.g. References) below 78 columns', async () => {
    // 30 message IDs without commas — historical bug: foldHeader only
    // split at address-list separators, so the entire References line
    // emitted as one ~1KB string and breached RFC 5322's 998-octet hard
    // limit. With whitespace-folding, every physical line stays well
    // below 78 chars and CRLF + WSP starts each continuation.
    const ids: Array<string> = [];
    for (let i = 0; i < 30; i++) {
      ids.push(`<msg-${i.toString().padStart(3, '0')}@example.com>`);
    }
    const refs = ids.join(' ');
    const { raw } = buildMime(
      await normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        threading: { references: refs, inReplyTo: ids[ids.length - 1] },
      }),
    );
    const text = new TextDecoder().decode(raw);
    const lines = text.split('\r\n');
    // Find the References line + any continuations (lines starting with
    // a single SP — RFC 5322 folding marker).
    const refIdx = lines.findIndex((l) => l.startsWith('References: '));
    expect(refIdx).toBeGreaterThanOrEqual(0);
    const collected: Array<string> = [lines[refIdx]];
    for (let i = refIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
        collected.push(lines[i]);
      } else {
        break;
      }
    }
    // Every physical line stays under RFC 5322's 998-octet limit and
    // also under our soft 78-octet target (we cap at ~76).
    for (const l of collected) {
      expect(l.length).toBeLessThanOrEqual(78);
    }
    // All 30 message IDs survive intact across the fold.
    const merged = collected.map((l, i) => (i === 0 ? l : l.trimStart())).join(' ');
    for (const id of ids) {
      expect(merged).toContain(id);
    }
    expect(collected.length).toBeGreaterThan(1); // actually folded
  });

  it('header-folds long address lists at unquoted comma boundaries only', async () => {
    // Construct a To list with quoted names containing commas, so that a
    // naive split-on-`, ` fold would corrupt the rendered headers. Verify
    // that all four addresses still render intact.
    const { text } = await build({
      from: 'a@x.dev',
      to: [
        { email: 'one@y.dev', name: 'Smith, John' },
        { email: 'two@y.dev', name: 'Doe, Jane' },
        { email: 'three@y.dev', name: 'Bob' },
        { email: 'four@y.dev', name: 'Roe, Mary' },
      ],
      subject: 's',
      text: 't',
    });
    expect(text).toContain('"Smith, John" <one@y.dev>');
    expect(text).toContain('"Doe, Jane" <two@y.dev>');
    expect(text).toContain('Bob <three@y.dev>');
    expect(text).toContain('"Roe, Mary" <four@y.dev>');
  });
});
