import { describe, expect, it } from 'vite-plus/test';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MimeError,
  normalizeEmail,
  parseAddress,
} from '../../src/runtime/email/mime.ts';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function build(opts: Parameters<typeof normalizeEmail>[0]) {
  const email = await normalizeEmail(opts);
  const { raw, messageId } = buildMime(email);
  return { raw, messageId, text: decode(raw) };
}

function b64ToText(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Collect one header's physical lines: the `Name:` line plus every
 * continuation (a line starting with WSP — RFC 5322 §2.2.3 folding).
 */
function headerLines(text: string, name: string): Array<string> {
  const lines = text.split('\r\n');
  const start = lines.findIndex((l) => l.startsWith(`${name}:`));
  if (start < 0) {
    throw new Error(`header '${name}' not found`);
  }
  const collected = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
      collected.push(lines[i]);
    } else {
      break;
    }
  }
  return collected;
}

/** RFC 5322 §2.2.3 unfolding: drop the CRLF, keep the leading WSP. */
function unfoldHeader(text: string, name: string): string {
  return headerLines(text, name).join('').slice(`${name}:`.length).trimStart();
}

/** Every encoded-word in a value, as raw `=?UTF-8?B?...?=` strings. */
function encodedWords(value: string): Array<string> {
  return value.match(/=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=/g) ?? [];
}

/**
 * Independent RFC 2047 decoder used as an in-test oracle. Per §6.2 the
 * linear whitespace separating two *adjacent* encoded-words is dropped
 * while whitespace next to ordinary text is kept. Each word is
 * base64-decoded on its own, which is only correct because §5 forbids
 * splitting a character across adjacent encoded-words — so this also
 * proves the chunker never cut a multi-octet character in half.
 */
function decodeEncodedWords(value: string): string {
  let out = '';
  let last = 0;
  let previousWasWord = false;
  for (const match of value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g)) {
    const gap = value.slice(last, match.index);
    if (!(previousWasWord && /^[ \t]*$/.test(gap))) {
      out += gap;
    }
    out += b64ToText(match[1]);
    last = match.index + match[0].length;
    previousWasWord = true;
  }
  return out + value.slice(last);
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

  // The shape check only required an '@' to be present anywhere, so a
  // trailing, leading or doubled separator passed the preflight and was
  // reported as a successful capture in the dev inbox — then failed only
  // after reaching the platform. Every code below is the ADVERTISED one.
  it.each(['user@', '@example.com', 'a@b@c'])(
    'rejects %s, which used to pass the preflight',
    async (bad) => {
      await expect(
        normalizeEmail({ from: bad, to: 'b@y.dev', subject: 's', text: 't' }),
      ).rejects.toThrow(/from/);
      await expect(
        normalizeEmail({ from: 'a@x.dev', to: bad, subject: 's', text: 't' }),
      ).rejects.toThrow(/to/);
    },
  );

  // Deliberately NOT the platform's own `isValidEmail`, which requires a dot
  // in the domain. These two are legal RFC 5321 and accepted today; adopting
  // that stricter rule here would newly reject them.
  it.each(['user@localhost', 'x@y'])('still accepts %s (no dot in the domain)', async (ok) => {
    const email = await normalizeEmail({ from: ok, to: ok, subject: 's', text: 't' });
    expect(email.from.email).toBe(ok);
  });

  // RFC 5322 §2.1.1 makes 998 a MUST and §3.2.2 allows folding ONLY at
  // whitespace, so a long token with no spaces cannot be folded at all —
  // `Subject:\r\n <token>` shortens nothing. The RFC 2047 chunking added
  // earlier only covers NON-ASCII values; a pure-ASCII token bypasses
  // `encodeWord` entirely and leaks through two separate paths in
  // `foldHeader`: the single-chunk early return, and the fold loop, which
  // still gives an over-long chunk its own line. Nothing downstream
  // repairs it — the proxy streams our bytes verbatim.
  const TOKEN = 'x'.repeat(1100);

  /** Longest physical line of the rendered message, in octets. */
  async function longestLine(opts: Record<string, unknown>): Promise<number> {
    const email = await normalizeEmail(opts as never);
    const raw = new TextDecoder().decode(buildMime(email).raw);
    return Math.max(...raw.split('\r\n').map((l) => new TextEncoder().encode(l).length));
  }

  it.each([
    ['subject', { from: 'a@x.dev', to: 'b@y.dev', subject: TOKEN, text: 't' }],
    [
      'a custom header value',
      { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't', headers: { 'X-Trace': TOKEN } },
    ],
    [
      'a display name',
      { from: { email: 'a@x.dev', name: TOKEN }, to: 'b@y.dev', subject: 's', text: 't' },
    ],
    [
      'an attachment filename',
      {
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${TOKEN}.pdf`, content: new Uint8Array([1, 2, 3]) }],
      },
    ],
  ])('rejects an unbreakable token in %s rather than emitting a >998 octet line', async (_w, o) => {
    await expect(normalizeEmail(o as never).then((e) => buildMime(e))).rejects.toThrow(
      /998|line length/i,
    );
  });

  it('still accepts a token that lands exactly on the limit', async () => {
    // `Subject: ` costs 9 octets, so 989 is the largest token that fits.
    expect(
      await longestLine({ from: 'a@x.dev', to: 'b@y.dev', subject: 'x'.repeat(989), text: 't' }),
    ).toBe(998);
  });

  it('leaves foldable values alone', async () => {
    const spaced = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    expect(
      await longestLine({ from: 'a@x.dev', to: 'b@y.dev', subject: spaced, text: 't' }),
    ).toBeLessThanOrEqual(998);
  });

  // A quoted-string parameter carries `\\` and `"` only as quoted-pairs
  // (RFC 5322 §3.2.4 — qtext excludes both). Deleting quotes and leaving
  // backslashes raw makes a trailing backslash escape the CLOSING quote,
  // and silently eats embedded ones: a Windows path `C:\\Users\\bob\\r.pdf`
  // reached the recipient as `C:Usersbobr.pdf`. This file's own folder
  // already tracks quoted-pairs, so the emitter was contradicting it.
  it.each([
    ['a trailing backslash', 'bad\\'],
    ['an embedded backslash', 'a\\b'],
    ['a Windows path', 'C:\\Users\\bob\\report.pdf'],
    ['an embedded quote', 'he said "hi".pdf'],
    ['a plain name', 'normal.pdf'],
  ])('round-trips %s in the attachment filename', async (_what, filename) => {
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename, content: new Uint8Array([1, 2, 3]) }],
    });
    const text = new TextDecoder().decode(buildMime(email).raw);

    // Recover it the way a receiver does: read the quoted-string back,
    // undoing quoted-pairs. A raw backslash before the closing quote would
    // leave the parameter unterminated and this would not match.
    const m = text.match(/Content-Disposition: attachment; filename="((?:[^"\\]|\\.)*)"/);
    expect(m, `no terminated filename parameter in:\n${text.slice(0, 400)}`).not.toBeNull();
    expect(m![1].replace(/\\(.)/g, '$1')).toBe(filename);
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

  // `MAX_MESSAGE_BYTES` used to be enforced ONLY at the end of `buildMime` —
  // after every attachment had been materialized in parallel by a
  // `Promise.all`, base64'd, sliced at 76 columns, joined and re-encoded.
  // Peak live memory measured about 10x the attachment bytes, so a set over
  // roughly 12 MiB terminated the isolate instead of returning the
  // `MIME_ERROR` the docs promise. Base64 expands by `ceil(n / 3) * 4`, so
  // nothing above three quarters of the message cap can ever fit anyway.
  const MAX_ATTACHMENT_BYTES_TOTAL = Math.floor((MAX_MESSAGE_BYTES * 3) / 4);

  /**
   * A one-byte Blob wearing a declared `size`, recording whether anything
   * ever read it. Shadowing beats allocating: the whole point is that the
   * second attachment's bytes are never touched.
   */
  function fakeBlob(name: string, size: number, reads: Array<string>): Blob {
    const blob = new Blob([new Uint8Array(1)]);
    Object.defineProperty(blob, 'size', { value: size });
    Object.defineProperty(blob, 'arrayBuffer', {
      value: async () => {
        reads.push(name);
        return new ArrayBuffer(size);
      },
    });
    return blob;
  }

  it('rejects an oversize attachment set without materializing past the first', async () => {
    const reads: Array<string> = [];
    const half = Math.ceil(MAX_ATTACHMENT_BYTES_TOTAL / 2) + 1;
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [
          { filename: 'first.bin', content: fakeBlob('first', half, reads) },
          { filename: 'second.bin', content: fakeBlob('second', half, reads) },
        ],
      }),
    ).rejects.toThrow(
      new RegExp(`exceeds Cloudflare limit of ${MAX_ATTACHMENT_BYTES_TOTAL} bytes`),
    );
    // The fix, stated as an assertion: the second attachment is charged from
    // its DECLARED size and rejected before a single byte of it is copied.
    expect(reads).toEqual(['first']);
  });

  it('still builds a legal attachment under the bound', async () => {
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: 'ok.bin', content: new Uint8Array(1024) }],
    });
    expect(text).toContain('Content-Disposition: attachment; filename="ok.bin"');
  });

  /**
   * An object address whose `email` records every read. `parseAddress` has
   * to read it to do anything at all, so an untouched entry proves the list
   * was refused before it was parsed.
   */
  function watchedAddress(reads: Array<number>, i: number): { email: string } {
    return {
      get email() {
        reads.push(i);
        return `u${i}@example.com`;
      },
    };
  }

  it('refuses more than MAX_RECIPIENTS across to, cc and bcc before parsing any of them', async () => {
    // The platform proxy refuses the same count on the deduplicated list,
    // but only after the tenant has parsed every entry and rendered the
    // `To:` header — measured, 230k short valid addresses (a legal 4.8 MiB
    // message) terminated a 128 MB isolate on the way there.
    const reads: Array<number> = [];
    const to = Array.from({ length: MAX_RECIPIENTS - 1 }, (_, i) => watchedAddress(reads, i));
    let error: unknown;
    try {
      await normalizeEmail({
        from: 'a@x.dev',
        to,
        cc: watchedAddress(reads, MAX_RECIPIENTS - 1),
        bcc: [watchedAddress(reads, MAX_RECIPIENTS)],
        subject: 's',
        text: 't',
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('INVALID_TO');
    expect((error as MimeError).message).toMatch(
      new RegExp(`too many recipients \\(max ${MAX_RECIPIENTS}, got ${MAX_RECIPIENTS + 1}\\)`),
    );
    expect(reads).toEqual([]);
  });

  it('accepts exactly MAX_RECIPIENTS across the three fields', async () => {
    const to = Array.from({ length: MAX_RECIPIENTS - 2 }, (_, i) => `u${i}@example.com`);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to,
      cc: 'cc@example.com',
      bcc: ['bcc@example.com'],
      subject: 's',
      text: 't',
    });
    expect(email.to.length + email.cc.length + email.bcc.length).toBe(MAX_RECIPIENTS);
  });

  it('refuses an address over MAX_ADDRESS_LENGTH, with the code for its field', async () => {
    // RFC 5321 §4.5.3.1: 64-octet local part + `@` + 255-octet domain.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(251)}.dev`;
    expect(longest).toHaveLength(MAX_ADDRESS_LENGTH);
    const over = `${'a'.repeat(65)}@${'b'.repeat(251)}.dev`;
    const email = await normalizeEmail({ from: longest, to: longest, subject: 's', text: 't' });
    expect(email.to[0].email).toBe(longest);
    for (const [field, code] of [
      ['to', 'INVALID_TO'],
      ['from', 'INVALID_FROM'],
      ['cc', 'MIME_ERROR'],
    ] as const) {
      let error: unknown;
      try {
        await normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          [field]: over,
          subject: 's',
          text: 't',
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe(code);
      expect((error as MimeError).message).toMatch(
        new RegExp(
          `^${field}: address is ${over.length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit`,
        ),
      );
    }
    // The bound is on the parsed address, as at the proxy — a long display
    // name around a legal address is not an oversize address.
    const named = await normalizeEmail({
      from: 'a@x.dev',
      to: `"${'n'.repeat(2 * MAX_ADDRESS_LENGTH)}" <${longest}>`,
      subject: 's',
      text: 't',
    });
    expect(named.to[0].email).toBe(longest);
  });

  it('parses the display-name form in linear time', () => {
    // `^\s*([^"<]+?)?\s*<` let three quantifiers share one run of
    // whitespace; the backtracker tried every split, cubic in the run.
    // Measured on that form: 2,000 spaces took 2 s, 4,000 took 10 s (16 s
    // when the `>` is missing). A regex cannot be interrupted, so keep the
    // run where a regression costs seconds, not the test's whole timeout.
    const run = ' '.repeat(4000);
    const started = performance.now();
    expect(parseAddress(`${run}a@b.c`, 'to')).toEqual({ email: 'a@b.c' });
    expect(() => parseAddress(`${run}<a@b.c`, 'to')).toThrow(MimeError);
    expect(parseAddress(`\t${run}Name${run}<a@b.c>${run}`, 'to')).toEqual({
      email: 'a@b.c',
      name: 'Name',
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps the display-name form’s language after the regex change', () => {
    // Shapes the old and new patterns were checked to agree on
    // (exhaustively to length 7 over a 9-symbol alphabet); pinned here.
    expect(parseAddress('a>b <c@d.e>', 'to')).toEqual({ email: 'c@d.e', name: 'a>b' });
    expect(parseAddress('x<a@b.c>', 'to')).toEqual({ email: 'a@b.c', name: 'x' });
    expect(parseAddress('\tJohn\tSmith\t<j@s.e>', 'to')).toEqual({
      email: 'j@s.e',
      name: 'John\tSmith',
    });
    expect(parseAddress('   <a@b.c>   ', 'to')).toEqual({ email: 'a@b.c' });
    expect(() => parseAddress('a"b <c@d.e>', 'to')).toThrow(MimeError);
    expect(() => parseAddress('a <b@c.d> e', 'to')).toThrow(MimeError);
    expect(() => parseAddress('<a b@c.d>', 'to')).toThrow(MimeError);
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

  it('caps every RFC 2047 encoded-word at 75 characters', async () => {
    // 16 CJK characters are 48 UTF-8 bytes. Encoded as one unbounded
    // word that is `=?UTF-8?B?` (10) + base64(48) (64) + `?=` (2) = 76
    // characters — one over RFC 2047 §2's 75-character ceiling. The
    // ceiling leaves 63 base64 characters, so 45 source bytes is the
    // largest payload that fits.
    const subject = '日本語のメールを送信します。テス';
    expect([...subject]).toHaveLength(16);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    const value = unfoldHeader(text, 'Subject');
    const words = encodedWords(value);
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(value)).toBe(subject);
  });

  it('folds a long non-ASCII subject under RFC 5322 §2.1.1 (998 octets)', async () => {
    // 246 CJK characters used to render as a single 1005-octet physical
    // line: past RFC 5322 §2.1.1's 998-octet MUST and RFC 5321
    // §4.5.3.1.6's 1000-octet SMTP text-line limit. Nothing downstream
    // repairs it — the proxy forwards these bytes verbatim.
    const subject = '日本語'.repeat(82);
    expect([...subject]).toHaveLength(246);
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    // Measure octets, not UTF-16 units — the limit is on the wire form.
    const encoder = new TextEncoder();
    for (const line of text.split('\r\n')) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(998);
    }
    const lines = headerLines(text, 'Subject');
    expect(lines.length).toBeGreaterThan(1); // actually folded
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const value = unfoldHeader(text, 'Subject');
    for (const word of encodedWords(value)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    expect(decodeEncodedWords(value)).toBe(subject);
    expect(raw.byteLength).toBeGreaterThan(0);
  });

  it('folds a very long non-ASCII subject (500 CJK characters)', async () => {
    const subject = '確認'.repeat(250);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    const encoder = new TextEncoder();
    for (const line of text.split('\r\n')) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(998);
    }
    expect(decodeEncodedWords(unfoldHeader(text, 'Subject'))).toBe(subject);
  });

  it('folds long non-ASCII display names in From and in address lists', async () => {
    // Display names run through the same encoder, so `From:` and every
    // recipient list inherits the same unbounded-line bug. The
    // multi-recipient case additionally exercises the address-list fold
    // branch, which never re-folded inside a single part.
    const name = '株式会社ボイドゼロの営業部'.repeat(20);
    const { text } = await build({
      from: { email: 'j@x.dev', name },
      to: [
        // A quoted display name whose own comma must survive the fold.
        { email: 'one@y.dev', name: 'Smith, John' },
        { email: 'two@y.dev', name },
        { email: 'three@y.dev', name: 'Bob' },
      ],
      subject: 's',
      text: 't',
    });
    const encoder = new TextEncoder();
    for (const line of text.split('\r\n')) {
      expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(998);
    }
    for (const header of ['From', 'To']) {
      const value = unfoldHeader(text, header);
      for (const word of encodedWords(value)) {
        expect(word.length).toBeLessThanOrEqual(75);
      }
    }
    expect(decodeEncodedWords(unfoldHeader(text, 'From'))).toBe(`${name} <j@x.dev>`);
    expect(decodeEncodedWords(unfoldHeader(text, 'To'))).toBe(
      `"Smith, John" <one@y.dev>, ${name} <two@y.dev>, Bob <three@y.dev>`,
    );
  });

  it('never splits an astral character across encoded-words', async () => {
    // RFC 2047 §5: "A multi-octet character may not be split across
    // adjacent encoded-words." A chunker that counted UTF-16 units — or
    // that base64'd once and sliced the output — would cut a 4-byte
    // emoji in half, and each half would decode to U+FFFD. Sweep the
    // leading padding so the astral run crosses the chunk boundary at
    // every possible byte offset.
    for (let pad = 0; pad < 8; pad++) {
      const subject = `${'x'.repeat(pad)}é🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉𠮷𠮷ok`;
      const { text } = await build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject,
        text: 't',
      });
      const value = unfoldHeader(text, 'Subject');
      const decoded = decodeEncodedWords(value);
      expect(decoded).not.toContain('�');
      expect(decoded).toBe(subject);
    }
  });

  it('keeps folding long ASCII header values at whitespace (control)', async () => {
    // Pure-ASCII values never reach the encoder, so this pins the
    // pre-existing whitespace-folding behaviour against regressions from
    // the encoded-word change.
    const words: Array<string> = [];
    for (let i = 0; i < 40; i++) {
      words.push(`word${i.toString().padStart(3, '0')}`);
    }
    const subject = words.join(' ');
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject,
      text: 't',
    });
    const lines = headerLines(text, 'Subject');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    expect(encodedWords(unfoldHeader(text, 'Subject'))).toHaveLength(0);
    expect(unfoldHeader(text, 'Subject')).toBe(subject);
  });
});

function bodyOf(text: string): string {
  return text.split('\r\n\r\n').slice(1).join('\r\n\r\n');
}

describe('buildMime body size projection', () => {
  // A 4 MiB non-ASCII body is 12.6 MiB once quoted-printable encoded, so it
  // can never fit. Before the projection, `buildMime` found that out only
  // after encoding it — measured at ~11x the UTF-8 bytes live — and a body a
  // few times over the limit terminated a 128 MB isolate instead of
  // returning `MIME_ERROR`. The projection is a single allocation-free pass
  // over the string, so this test is fast and the rejected string is small.
  it('rejects a body that cannot fit before encoding it', async () => {
    const cjk = '漢'.repeat(Math.ceil((4 * 1024 * 1024) / 3));
    const email = await normalizeEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: cjk });
    let error: unknown;
    try {
      buildMime(email);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('MIME_ERROR');
    // The projection's message, not the post-render one: the body was never encoded.
    expect((error as MimeError).message).toMatch(
      new RegExp(
        `at least \\d+ bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes`,
      ),
    );
  });

  it('counts text and html together', async () => {
    // Each alone projects under the limit; together they cannot fit.
    const half = '漢'.repeat(Math.ceil((1.8 * 1024 * 1024) / 3));
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: half }),
    ).resolves.toBeTruthy();
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: half, html: half }),
    ).rejects.toThrow(/at least \d+ bytes once encoded/);
  });

  it('never rejects a message that fits, and leaves the final check as the authority', async () => {
    // 3.3 MiB of CJK projects to ~10.38 MiB (under the cap, since the
    // projection ignores soft breaks and headers) but renders to ~10.8 MiB.
    // The projection must let it through; the post-render check must reject it.
    const nearly = '漢'.repeat(Math.ceil((3.3 * 1024 * 1024) / 3));
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: nearly,
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a 3 MiB body, whose message is ~9.4 MiB, builds.
    const fits = '漢'.repeat(Math.ceil((3 * 1024 * 1024) / 3));
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: fits });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe('buildMime header size projection', () => {
  const PROJECTION = new RegExp(
    `message is at least \\d+ bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes`,
  );

  async function expectProjected(opts: Parameters<typeof normalizeEmail>[0]) {
    const email = await normalizeEmail(opts);
    let error: unknown;
    try {
      buildMime(email);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MimeError);
    expect((error as MimeError).code).toBe('MIME_ERROR');
    // The projection's message, not the post-render one: nothing was encoded.
    expect((error as MimeError).message).toMatch(PROJECTION);
  }

  // A non-ASCII header value is B-encoded into 45-byte words of 72 octets
  // each and folded one per line: 5 octets for every CJK character, so 3M
  // characters (9 MB of UTF-8) is a 15 MB header. Before the header bound,
  // `buildMime` encoded, folded, joined and re-encoded all of that before
  // it measured anything, and a 7M-character subject terminated a 128 MB
  // isolate instead of returning `MIME_ERROR`.
  it('rejects a subject that cannot fit before encoding it', async () => {
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: '漢'.repeat(3_000_000),
      text: 'hi',
    });
  });

  it('counts every display name across the recipient list', async () => {
    await expectProjected({
      from: 'a@x.dev',
      to: Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
        email: `u${i}@y.dev`,
        name: '漢'.repeat(30_000),
      })),
      subject: 's',
      text: 'hi',
    });
  });

  it('counts a custom header, and not a reserved one that is never rendered', async () => {
    const big = 'x'.repeat(11 * 1024 * 1024);
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      headers: { 'X-Note': big },
    });
    // `Subject` in the custom map is dropped by `buildMime`, so charging it
    // would reject a message that fits.
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      headers: { Subject: big },
    });
    expect(text).toContain('Subject: s\r\n');
  });

  it('never charges the whitespace that folding collapses', async () => {
    // `foldHeader` re-joins a long value from its non-WSP tokens, so 11 MiB
    // of spaces renders as one. A bound that counted `length` would reject
    // this message; it fits.
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: `a${' '.repeat(11 * 1024 * 1024)}b`,
      text: 'hi',
    });
    expect(text).toContain('Subject: a b\r\n');
  });

  it('never rejects a header-heavy message that fits, and leaves the final check as the authority', async () => {
    // 2.15M CJK characters project to ~10.32 MiB (4.8 octets each: the bound
    // omits the fold's CRLF per word) but render to ~10.75 MB at 5 octets
    // each. The projection must let it through; the post-render check must
    // reject it.
    const nearly = '漢'.repeat(2_150_000);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: nearly,
      text: 'hi',
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And 2M characters, whose message is ~10.0 MB, builds.
    const fits = '漢'.repeat(2_000_000);
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: fits, text: 'hi' });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });
});

describe('foldHeader memory', () => {
  // A legal 3 MB subject of one-letter words is 1.5M fold points. The
  // earlier fold kept a slice, a `{ text, comma }` object and a cons-string
  // node per token — about 65 bytes of heap per input character — and
  // terminated a 128 MB isolate on a message that fit. The fold now keeps
  // only its finished lines (~1 byte per character). This pins the
  // rendered shape; the memory bound is measured, not asserted, because
  // the test runner's heap is not the isolate's.
  it('folds a legal subject of millions of one-letter words', async () => {
    const words = 1_500_000;
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 'a '.repeat(words).trimEnd(),
      text: 'hi',
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    const lines = headerLines(text, 'Subject');
    expect(lines[0]).toBe(`Subject:${' a'.repeat(34)}`);
    expect(lines.every((l) => l.length <= 76)).toBe(true);
    expect(unfoldHeader(text, 'Subject')).toBe('a '.repeat(words).trimEnd());
  });
});

describe('quotedPrintable encoder', () => {
  // Fixtures captured from the string-concatenating encoder these replace,
  // so the byte-buffer encoder is pinned to the exact previous output.
  const cases: Array<[string, string, string]> = [
    [
      'soft-breaks at 76 columns',
      'é'.repeat(30),
      '=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=\r\n=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9=\r\n=C3=A9=C3=A9=C3=A9=C3=A9=C3=A9',
    ],
    ['quotes trailing whitespace', 'a \nb\t\nc é', 'a=20\r\nb=09\r\nc =C3=A9'],
    ['quotes control bytes and =', 'a\u0001b=é', 'a=01b=3D=C3=A9'],
    ['normalizes CR, LF and CRLF', 'l1\r\nl2\rl3\nl4é', 'l1\r\nl2\r\nl3\r\nl4=C3=A9'],
    [
      'does not split a quoted byte across a soft break',
      'a'.repeat(100) + 'é',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=\r\naaaaaaaaaaaaaaaaaaaaaaaaa=C3=A9',
    ],
  ];
  for (const [name, input, expected] of cases) {
    it(name, async () => {
      const { text } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: input });
      expect(text).toContain('Content-Transfer-Encoding: quoted-printable');
      expect(bodyOf(text)).toBe(expected);
    });
  }
});
