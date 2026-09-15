import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_BYTES,
  MAX_RECIPIENTS,
  MimeError,
  normalizeEmail,
  parseAddress,
} from '../../src/runtime/email/mime.ts';
import type { Attachment } from '../../src/runtime/email/types.ts';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The one shape message `validateAddressParts` throws: the rule is
 * `email-validator`, and the message names the rule rather than echoing the
 * address (which may hold a control character).
 */
function invalidAddress(field: string): string {
  return (
    `${field}: address is not a valid email address (ASCII local part and dotted domain, ` +
    `RFC 5322 dot-atom; at most 64 characters before the '@' and 254 in total).`
  );
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

  // Inverted: these used to be accepted as legal RFC 5321 mailboxes while
  // the platform router refused them for the missing dot, so a handler's
  // `forward('user@localhost')` was recorded here and dropped there. The
  // rule is now `email-validator` on both sides, which wants a dotted
  // domain with a letter-first TLD of at least two characters.
  it.each(['user@localhost', 'x@y', 'a@example'])(
    'now refuses %s (no dot in the domain), as the router always did',
    async (bad) => {
      await expect(
        normalizeEmail({ from: bad, to: 'b@y.dev', subject: 's', text: 't' }),
      ).rejects.toThrow(invalidAddress('from'));
      await expect(
        normalizeEmail({ from: 'a@x.dev', to: bad, subject: 's', text: 't' }),
      ).rejects.toThrow(invalidAddress('to'));
    },
  );

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

  it('measures a line in UTF-8 octets, not UTF-16 units, and reports its number', async () => {
    // A CJK filename is rendered verbatim into ` filename="…"`: 3 octets per
    // character inside 12 of framing, so 328 characters land exactly on the
    // 998-octet limit and 329 are one octet over. The pre-render guard sees
    // only `length` (341) and lets both through; the post-render scan must
    // count octets. The line number pins the CRLF-delimited index into the
    // multipart body, where the part's own headers live.
    const fits = '漢'.repeat(328);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: fits, content: 'x' }],
    });
    expect(text).toContain(`\r\n filename="${fits}"\r\n`);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${fits}漢`, content: 'x' }],
      }),
    ).rejects.toThrow(/header line 19 is 999 octets, over the 998-octet limit/);
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

  it("rejects an attachment disposition other than 'attachment' or 'inline'", async () => {
    // `Attachment.disposition` is a two-literal union at compile time only.
    // A JS caller, or a JSON-parsed options object, can pass any string,
    // and `buildAttachmentPart` interpolates it verbatim into
    // `Content-Disposition`. Unlike its neighbours it never went through
    // `rejectCRLF`, so a CRLF in it rendered as a second header line inside
    // the attachment part (`X-Injected: 1; filename="f.txt"`), and a blank
    // line in it ended the part's header block early.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const message = "attachment disposition must be 'attachment' or 'inline'.";
    for (const disposition of [
      'attachment\r\nX-Injected: 1',
      'attachment\r\n\r\nbody',
      'form-data',
    ]) {
      const attempt = normalizeEmail({
        ...base,
        attachments: [{ filename: 'f.txt', content: 'x', disposition: disposition as never }],
      });
      await expect(attempt).rejects.toThrow(message);
      await expect(attempt).rejects.toMatchObject({ code: 'MIME_ERROR' });
    }
    // Both literals still render as given, whatever the body shape.
    for (const disposition of ['attachment', 'inline'] as const) {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'f.txt', content: 'x', disposition }],
      });
      expect(text).toContain(`Content-Disposition: ${disposition}; filename="f.txt"`);
    }
    // And an omitted disposition still defaults on `contentId`.
    const defaulted = await normalizeEmail({
      ...base,
      attachments: [
        { filename: 'f.txt', content: 'x' },
        { filename: 'logo.png', content: 'x', contentId: 'logo' },
      ],
    });
    expect(defaulted.attachments.map((a) => a.disposition)).toEqual(['attachment', 'inline']);
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

  describe('attachment count', () => {
    // `MAX_ATTACHMENT_BYTES_TOTAL` never advances on a zero-byte attachment,
    // and the size projection in `buildMime` runs only after every entry
    // has been normalized — about 275 bytes of live heap each. Measured, 2M
    // empty attachments terminated a 128 MB isolate in 0.3 s instead of
    // returning `MIME_ERROR`. The count is now refused before the loop, at
    // the largest count the projection could admit: 119 octets per part —
    // `ATTACHMENT_PART_MIN_OCTETS` plus a one-character filename rendered
    // twice — under `MAX_MESSAGE_BYTES`.
    const PART_MIN_OCTETS = 117 + 2;

    /** An attachment that records any read of the fields the loop touches first. */
    function watchedAttachment(reads: Array<number>, i: number): Attachment {
      return {
        get filename() {
          reads.push(i);
          return 'a';
        },
        get content() {
          reads.push(i);
          return '';
        },
      };
    }

    it('is derived from the per-part floor and the message cap', () => {
      expect(MAX_ATTACHMENTS).toBe(Math.floor(MAX_MESSAGE_BYTES / PART_MIN_OCTETS));
      expect(MAX_ATTACHMENTS).toBe(88_115);
    });

    it('refuses one over MAX_ATTACHMENTS before normalizing any of them', async () => {
      const reads: Array<number> = [];
      const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
        watchedAttachment(reads, i),
      );
      let error: unknown;
      try {
        await normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
          attachments,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      expect((error as MimeError).message).toBe(
        `email: too many attachments (max ${MAX_ATTACHMENTS}, got ${MAX_ATTACHMENTS + 1}).`,
      );
      expect(reads).toEqual([]);
    });

    it('accepts exactly MAX_ATTACHMENTS', async () => {
      const one = { filename: 'a', content: '' };
      const email = await normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: Array.from({ length: MAX_ATTACHMENTS }, () => one),
      });
      expect(email.attachments.length).toBe(MAX_ATTACHMENTS);
    });

    it('never rejects a count the size projection would have admitted', () => {
      // The smallest part there is: a one-character filename, an empty
      // media type and no content. One over the cap is refused by the
      // projection on framing alone, so the count bound only ever refuses
      // what `buildMime` was going to; exactly at the cap the projection
      // admits it and the post-render check is the one to refuse the
      // 12.9 MB it renders to.
      const part = {
        filename: 'a',
        contentType: '',
        bytes: new Uint8Array(0),
        contentId: undefined,
        disposition: 'inline' as const,
      };
      const email = (n: number) => ({
        from: { email: 'a@x.dev' },
        to: [{ email: 'b@y.dev' }],
        cc: [],
        bcc: [],
        subject: 's',
        text: 't',
        headers: {},
        attachments: Array.from({ length: n }, () => part),
      });
      expect(() => buildMime(email(MAX_ATTACHMENTS + 1))).toThrow(
        /message is at least \d+ bytes once encoded, which exceeds Cloudflare limit/,
      );
      expect(() => buildMime(email(MAX_ATTACHMENTS))).toThrow(
        /message size \d+ bytes exceeds Cloudflare limit/,
      );
    });

    it('refuses a non-array attachments value instead of walking it unbounded', async () => {
      // A `Set` iterates but has no `length`, so a count read off the
      // options would bound nothing; the type admits only an array.
      await expect(
        normalizeEmail({
          from: 'a@x.dev',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
          attachments: new Set([{ filename: 'a', content: '' }]) as unknown as Array<Attachment>,
        }),
      ).rejects.toThrow(/attachments must be an array/);
    });
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

  it('refuses a quoted filename that could never fold onto a legal line, before rendering it', async () => {
    // ` filename="…"` is the shortest line a quoted parameter can land on:
    // 12 octets plus the name. The post-render line check refuses the same
    // input, but only after `quoteParam` has escaped it — measured, a
    // filename of ~1.7M quote characters killed a 128 MB isolate there.
    const longest = 'a'.repeat(998 - 12);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: [{ filename: longest, content: 'x' }],
    });
    expect(text).toContain(`filename="${longest}"`);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: `${longest}b`, content: 'x' }],
      }),
    ).rejects.toThrow(
      /attachment filename is 987 characters; a quoted `filename=` parameter cannot be folded/,
    );
    // The guard is cheap on the input that used to be fatal.
    const started = performance.now();
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        attachments: [{ filename: '"'.repeat(2_000_000), content: 'x' }],
      }),
    ).rejects.toThrow(/cannot be folded/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses a quoted display name that could never fold onto a legal line', async () => {
    // Only a name that must be QUOTED (ASCII with specials) is one
    // unbreakable token; a plain name folds at its spaces and a non-ASCII
    // name becomes encoded-words, so neither is bounded here.
    const plain = 'word '.repeat(300).trim();
    await expect(
      build({ from: 'a@x.dev', to: { email: 'b@y.dev', name: plain }, subject: 's', text: 't' }),
    ).resolves.toBeTruthy();
    const quotedFits = `x,${'a'.repeat(998 - 3 - 2)}`;
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: quotedFits },
        subject: 's',
        text: 't',
      }),
    ).resolves.toBeTruthy();
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: `${quotedFits}b` },
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(
      /to: display name is 996 characters and must be quoted, which cannot be folded/,
    );
    await expect(
      build({
        from: 'a@x.dev',
        to: { email: 'b@y.dev', name: '"'.repeat(2_000_000) },
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/cannot be folded/);
  });

  it('refuses a header name that could never sit on a legal line, before rendering it', async () => {
    // A field name never folds. `Name:` alone is the shortest line it can
    // sit on — what `foldHeader` emits when the value's first token does
    // not fit beside a long name — so 997 characters is the longest name
    // with ANY legal rendering, and only with a value that folds: `Name:`
    // is 998 octets, then ` a b`. The same name over an empty value is one
    // 999-octet line, which is the post-render line check's to refuse, not
    // this guard's: a bound one character tighter would reject a message
    // that fits.
    const longest = `X${'a'.repeat(998 - 1 - 1)}`;
    expect(longest).toHaveLength(997);
    const { text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: { [longest]: 'a b' },
    });
    expect(headerLines(text, longest)).toEqual([`${longest}:`, ' a b']);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { [longest]: '' },
      }),
    ).rejects.toThrow(/header line \d+ is 999 octets, over the 998-octet limit/);
    // One character more has no legal rendering whatever the value.
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { [`${longest}b`]: 'a b' },
      }),
    ).rejects.toThrow(/headers: a header name is 998 characters; a field name cannot be folded/);
    // The guard is cheap on the input that used to be rendered four times
    // over before the line check saw it: a 5 MiB name took 23 ms and
    // 5.6 MB of heap to refuse post-render (measured); a 50 MiB one killed
    // a 128 MB isolate. Refused here in 2 ms with no allocation.
    const started = performance.now();
    await expect(
      normalizeEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { ['X'.repeat(5 * 1024 * 1024)]: '' },
      }),
    ).rejects.toThrow(/a field name cannot be folded/);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('refuses an address over MAX_ADDRESS_LENGTH, with the code for its field', async () => {
    // RFC 5321 §4.5.3.1: 64-octet local part + `@` + 255-octet domain is the
    // sum of the component maxima — the pre-parse bound, not a deliverable
    // path (the package's 254 total is that). At exactly 320 the package
    // answers; one over, this one answers first, before anything is scanned.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(251)}.dev`;
    expect(longest).toHaveLength(MAX_ADDRESS_LENGTH);
    const over = `${'a'.repeat(65)}@${'b'.repeat(251)}.dev`;
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: longest, subject: 's', text: 't' }),
    ).rejects.toThrow(invalidAddress('to'));
    // 254 characters of 63-character-or-shorter labels: the longest address
    // the package accepts.
    const deliverable = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.dev`;
    expect(deliverable).toHaveLength(254);
    const email = await normalizeEmail({
      from: deliverable,
      to: deliverable,
      subject: 's',
      text: 't',
    });
    expect(email.to[0].email).toBe(deliverable);
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
      to: `"${'n'.repeat(2 * MAX_ADDRESS_LENGTH)}" <${deliverable}>`,
      subject: 's',
      text: 't',
    });
    expect(named.to[0].email).toBe(deliverable);
  });

  it('refuses an address over 254 characters (RFC 5321 §4.5.3.1.3), by the package rule', async () => {
    // RFC 5321 §4.5.3.1.3: a 256-octet forward-path `<local@domain>` is the
    // longest every receiver MUST accept, so the address is at most 254.
    // The 320 total is the sum of the local-part and domain maxima, not a
    // path — `a@` + a 255-octet domain is 257 characters, under the
    // total-length bound, and `void dev` and the test harness once captured
    // it as a success. `email-validator` checks 254 before its regex, and
    // the platform router applies the same package, so both sides refuse it.
    const label = 'b'.repeat(63);
    const domain255 = [label, label, label, label].join('.');
    expect(domain255).toHaveLength(255);
    const over = `a@${domain255}`;
    expect(over).toHaveLength(257);
    expect(over.length).toBeLessThan(MAX_ADDRESS_LENGTH);
    const longest = `a@${domain255.slice(0, 252)}`;
    expect(longest).toHaveLength(254);
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
      expect((error as MimeError).message).toBe(invalidAddress(field));
    }
    // Inverted: a raw IDN domain used to be accepted and counted in UTF-8
    // octets (SMTPUTF8). The package is ASCII-only, so octets and characters
    // are the same thing and a raw `ü` label is refused however short; the
    // same domain is accepted as punycode, which is what DNS carries.
    const idnRaw = `a@${'ü'.repeat(31)}.${'b'.repeat(63)}`;
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: idnRaw, subject: 's', text: 't' }),
    ).rejects.toThrow(invalidAddress('to'));
    const punycode = 'a@xn--bcher-kva.example';
    const idn = await normalizeEmail({ from: 'a@x.dev', to: punycode, subject: 's', text: 't' });
    expect(idn.to[0].email).toBe(punycode);
    // A label over 63 characters is refused on its own, inside the 254 total.
    const longLabel = `a@${'b'.repeat(64)}.dev`;
    await expect(
      normalizeEmail({ from: 'a@x.dev', to: longLabel, subject: 's', text: 't' }),
    ).rejects.toThrow(invalidAddress('to'));
    // The display-name form is bounded on the same parsed address, and the
    // total-length bound still answers first for one over both.
    expect(() => parseAddress(`Name <${over}>`, 'to')).toThrow(invalidAddress('to'));
    expect(() => parseAddress(`${'a'.repeat(65)}@${domain255.slice(0, 200)}`, 'to')).toThrow(
      invalidAddress('to'),
    );
    expect(() => parseAddress(`${'a'.repeat(65)}@${domain255}`, 'to')).toThrow(
      /over the 320-character limit/,
    );
  });

  it('refuses a local part over 64 characters (RFC 5321 §4.5.3.1.1), by the package rule', async () => {
    // RFC 5321 §4.5.3.1.1: 64 octets is the longest local part every
    // receiver MUST accept. The total-length bound alone let this through
    // — `'a'.repeat(65)}@x.dev` is 71 characters — so `void dev` and the
    // test harness once captured it as a success. `email-validator`
    // enforces the 64, and the platform router applies the same package.
    const longest = `${'a'.repeat(64)}@x.dev`;
    const over = `${'a'.repeat(65)}@x.dev`;
    expect(over.length).toBeLessThan(MAX_ADDRESS_LENGTH);
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
      expect((error as MimeError).message).toBe(invalidAddress(field));
    }
    // Inverted: a non-ASCII local part (SMTPUTF8) used to be accepted and
    // counted in UTF-8 octets. The package is ASCII-only, so `ünicode@` and
    // a CJK local part are refused however short, on both sides.
    for (const bad of ['ünicode@example.com', 'jöhn@example.com', `${'漢'.repeat(21)}@x.dev`]) {
      await expect(
        normalizeEmail({ from: 'a@x.dev', to: bad, subject: 's', text: 't' }),
      ).rejects.toThrow(invalidAddress('to'));
    }
    // The display-name form is bounded on the same parsed address, and the
    // total-length bound still answers first for an address over both.
    expect(() => parseAddress(`Name <${over}>`, 'to')).toThrow(invalidAddress('to'));
    expect(() => parseAddress(`${'a'.repeat(65)}@${'b'.repeat(251)}.dev`, 'to')).toThrow(
      /over the 320-character limit/,
    );
  });

  describe('control characters in an address', () => {
    // Every C0 control and DEL once passed the hand-written rule (which
    // refused only CR, LF, NUL and what `\s` matches): `a\x01b@example.com`
    // was accepted and `formatAddress` wrote the byte raw into the `To:`
    // line, captured as a success under `void dev` and by the test harness,
    // and dropped by the platform router after earlier actions had fired.
    // `email-validator` admits only `atext`, so every control is refused,
    // and the message never echoes the address.
    const controls = [
      ['SOH', '\x01'],
      ['ESC', '\x1b'],
      ['US', '\x1f'],
      ['DEL', '\x7f'],
      ['TAB', '\t'],
    ] as const;

    it('refuses a bare address carrying one, with the code for its field', async () => {
      for (const [, ch] of controls) {
        const bad = `a${ch}b@example.com`;
        for (const [field, code] of [
          ['to', 'INVALID_TO'],
          ['from', 'INVALID_FROM'],
          ['cc', 'MIME_ERROR'],
          ['bcc', 'MIME_ERROR'],
          ['replyTo', 'MIME_ERROR'],
        ] as const) {
          let error: unknown;
          try {
            await normalizeEmail({
              from: 'a@x.dev',
              to: 'b@y.dev',
              [field]: bad,
              subject: 's',
              text: 't',
            });
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(MimeError);
          expect((error as MimeError).code).toBe(code);
          expect((error as MimeError).message).toBe(invalidAddress(field));
          expect((error as MimeError).message).not.toContain(ch);
        }
      }
    });

    it('refuses it in the object and display-name forms on the same parsed address', async () => {
      for (const [, ch] of controls) {
        const bad = `a${ch}b@example.com`;
        await expect(
          normalizeEmail({
            from: 'a@x.dev',
            to: { name: 'Bob', email: bad },
            subject: 's',
            text: 't',
          }),
        ).rejects.toThrow(invalidAddress('to'));
        expect(() => parseAddress(`Bob <${bad}>`, 'to')).toThrow(invalidAddress('to'));
      }
      // CR, LF and NUL in the object form reach the address rule directly
      // (the string form is refused before it is parsed, by `rejectCRLF`):
      // the package refuses them with the field's own code, so dropping the
      // separate CRLF scan from the bare address lost nothing.
      for (const ch of ['\r', '\n', '\0']) {
        let error: unknown;
        try {
          await normalizeEmail({
            from: 'a@x.dev',
            to: { email: `a${ch}b@example.com` },
            subject: 's',
            text: 't',
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(MimeError);
        expect((error as MimeError).code).toBe('INVALID_TO');
        expect((error as MimeError).message).toBe(invalidAddress('to'));
        expect(() => parseAddress(`Bob <a${ch}b@example.com>`, 'to')).toThrow(
          /must not contain CR, LF, or NUL/,
        );
      }
      // The length bound still answers first: the scan is over at most 320
      // characters, so an over-long address is refused before it is read.
      expect(() => parseAddress(`a\x01${'b'.repeat(320)}@x.dev`, 'to')).toThrow(
        /over the 320-character limit/,
      );
    });

    it('never renders one raw from a display name, which is encoded instead', async () => {
      // A name is not an address: a control in it is a character like any
      // other and `formatAddress` RFC 2047-encodes the non-printable name,
      // so the byte reaches the wire only inside base64. Pinned so the
      // address rule is never mistaken for the reason the header is clean.
      // Every C0 control and DEL except the CR and LF that delimit lines.
      // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
      const rawControl = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/;
      for (const [, ch] of controls) {
        const { text } = await build({
          from: 'a@x.dev',
          to: { name: `Bo${ch}b`, email: 'b@y.dev' },
          subject: 's',
          text: 't',
        });
        const toLine = unfoldHeader(text, 'To');
        expect(toLine).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <b@y\.dev>$/);
        expect(decodeEncodedWords(toLine)).toBe(`Bo${ch}b <b@y.dev>`);
        expect(text.slice(0, text.indexOf('\r\n\r\n'))).not.toMatch(rawControl);
      }
    });
  });

  describe('control characters in an attachment filename', () => {
    // `rejectCRLF` refused only CR, LF and NUL, and a filename is rendered
    // through `quoteParam` — never `encodeWord` — so `invoice\x01.pdf` was
    // written raw into both `name="…"` and `filename="…"` (measured on the
    // wire: `… 69 6e 76 6f 69 63 65 01 2e 70 64 66 22`), captured as a
    // success under `void dev` and by the harness, and left for the
    // receiving MTA. RFC 5322 §3.2.4 `qtext` is printable US-ASCII less `"`
    // and `\`; a control in a quoted-string is `obs-qtext`, which §4 says
    // MUST NOT be generated. The message names the code point and never
    // echoes the value.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const controls = [
      ['SOH', '\x01', 'U+0001'],
      ['ESC', '\x1b', 'U+001B'],
      ['US', '\x1f', 'U+001F'],
      ['DEL', '\x7f', 'U+007F'],
    ] as const;

    it('refuses one, naming its code point rather than echoing it', async () => {
      for (const [, ch, point] of controls) {
        let error: unknown;
        try {
          await normalizeEmail({
            ...base,
            attachments: [{ filename: `invoice${ch}.pdf`, content: 'x' }],
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(MimeError);
        expect((error as MimeError).code).toBe('MIME_ERROR');
        expect((error as MimeError).message).toBe(
          `attachment filename contains a control character (${point}).`,
        );
        expect((error as MimeError).message).not.toContain(ch);
      }
      // CR, LF and NUL still answer first, with the message they always had.
      for (const ch of ['\r', '\n', '\0']) {
        await expect(
          normalizeEmail({ ...base, attachments: [{ filename: `a${ch}b.pdf`, content: 'x' }] }),
        ).rejects.toThrow('attachment filename: must not contain CR, LF, or NUL.');
      }
    });

    it('accepts HTAB, which is folding white space inside a quoted-string (RFC 5322 §3.2.4), unchanged', async () => {
      // `quoted-string = DQUOTE *([FWS] qcontent) [FWS] DQUOTE` and `FWS` is
      // made of `WSP` (SP / HTAB), so a tab between characters is legal
      // exactly as a space is; `obs-NO-WS-CTL`, the RFC's own list of the
      // controls that used to be `qtext`, leaves %d9 out. Rendered as it
      // was: raw, inside the quotes, in both parameters.
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'a\tb.pdf', content: 'x' }],
      });
      expect(text).toContain('; name="a\tb.pdf"\r\n');
      expect(text).toContain('; filename="a\tb.pdf"\r\n');
    });

    it('still renders a non-ASCII filename as raw UTF-8 in the quoted parameter', async () => {
      // The existing path, pinned: no RFC 2231 `filename*=` and no
      // encoded-word — the UTF-8 octets go inside the quotes as they did.
      const { raw, text } = await build({
        ...base,
        attachments: [{ filename: 'résumé.pdf', content: 'x' }],
      });
      expect(text).toContain('; name="résumé.pdf"\r\n');
      expect(text).toContain('; filename="résumé.pdf"\r\n');
      expect(text).not.toContain('filename*=');
      const hex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      expect(hex).toContain('66 69 6c 65 6e 61 6d 65 3d 22 72 c3 a9 73 75 6d c3 a9 2e 70 64 66 22');
    });

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": an over-long filename is refused by the
      // `QUOTED_FILENAME_LINE_OVERHEAD` guard before its characters are read.
      const filename = `a\x01${'b'.repeat(2000)}.pdf`;
      await expect(
        normalizeEmail({ ...base, attachments: [{ filename, content: 'x' }] }),
      ).rejects.toThrow(
        new RegExp(
          `attachment filename is ${filename.length} characters; a quoted \`filename=\` parameter cannot be folded`,
        ),
      );
    });

    it('refuses one in the media type by the same rule', async () => {
      // `Content-Type: <contentType>; name="…"` is rendered verbatim, and an
      // RFC 2045 §5.1 `token` excludes CTLs.
      await expect(
        normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.pdf', content: 'x', contentType: 'application/pdf\x01' }],
        }),
      ).rejects.toThrow('attachment contentType contains a control character (U+0001).');
    });

    it('refuses one in the Content-ID by the same rule', async () => {
      // `Content-ID: <cid>` is rendered verbatim, and an RFC 5322 §3.6.4
      // `msg-id` is `dot-atom-text` — no control at all.
      await expect(
        normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.png', content: 'x', contentId: 'lo\x7fgo' }],
        }),
      ).rejects.toThrow('attachment contentId contains a control character (U+007F).');
    });
  });

  describe('media type syntax of an attachment', () => {
    // `rejectControls` answered only for CTLs, and `buildAttachmentPart`
    // writes the media type verbatim ahead of its own `; name="…"`, so
    // `text/plain; x="` rendered `Content-Type: text/plain; x="; name="a.txt"`
    // — captured as a success under `void dev` and by the harness, while
    // Python's `email` reports `end of header inside quoted string` on that
    // line and reads the builder's `name` as the VALUE of `x`. The grammar
    // is RFC 2045 §5.1 `type "/" subtype *(";" parameter)`, read as a
    // generator; the message names the rule and never echoes the value.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
    const SYNTAX =
      'attachment contentType is not a valid media type (RFC 2045 §5.1: type/subtype, then ; attribute=value parameters).';

    async function refused(contentType: string): Promise<MimeError> {
      let error: unknown;
      try {
        await normalizeEmail({
          ...base,
          attachments: [{ filename: 'a.txt', content: 'x', contentType }],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      return error as MimeError;
    }

    it('refuses one that does not parse, naming the rule rather than echoing it', async () => {
      const invalid = [
        'text/plain; x="', // unterminated quoted-string
        'text/plain; x="a\\"', // the `\` escapes the closing quote
        'text/plain; charset', // attribute without `=` value
        'text/plain; charset=', // empty token value (`""` is the empty value)
        'text/plain; x=a/b', // `/` is a tspecial; must be quoted
        'text', // subtype is MANDATORY (§5.1)
        'text/', //
        '/plain', //
        'text/plain/x', //
        'text/ plain', // WSP inside the type
        'text plain', //
        ' text/plain', // leading WSP
        'text/plain ', // trailing WSP
        'text/plain;', // `;` owes a parameter
        'text/plain;;', //
        'text/plain; ; a=b', //
        'text/plain; a=b,c', // `,` is a tspecial
        'text/plain (plain text)', // an RFC 822 comment: refused, not stripped
        'tëxt/plain', // token is US-ASCII
        'text/plain; ä=b', //
        'text/plain; a=ö', //
        '', //
      ];
      for (const contentType of invalid) {
        const error = await refused(contentType);
        expect(error.message, contentType).toBe(SYNTAX);
        if (contentType.length > 0) {
          expect(error.message).not.toContain(contentType);
        }
      }
    });

    it('accepts every valid form and renders it as it did, byte for byte', async () => {
      const valid = [
        'TEXT/PLAIN', // case is kept as given; matching is case-insensitive
        'application/vnd.ms-excel',
        'application/x-foo.bar-baz_1', // `.`, `-`, `_` are token characters
        'image/svg+xml',
        'text/plain; charset=utf-8',
        'text/plain; charset="utf-8"',
        'text/plain;charset=utf-8', // no WSP after `;`
        'text/plain ; charset=utf-8', // WSP before `;` (RFC 822 implicit LWSP)
        'text/plain;\tcharset=utf-8', // HTAB is WSP
        'text/plain; charset=""', // the empty quoted-string is a value
        'text/plain; title="a \\"b\\" \\\\ c; d=e"', // quoted-pairs, and `;` inside quotes
        'text/plain; title="résumé"', // what `name="résumé.pdf"` already carries
        'multipart/x-thing; a=1; B=2', // distinct attributes
      ];
      for (const contentType of valid) {
        const { text } = await build({
          ...base,
          attachments: [{ filename: 'a.txt', content: 'x', contentType }],
        });
        // Verbatim, then the builder's own parameter — exactly the line the
        // unchecked path rendered.
        expect(text, contentType).toContain(`Content-Type: ${contentType}; name="a.txt"\r\n`);
      }
    });

    /**
     * The attachment part's `Content-Type` header, every physical line of
     * it: the lines between `Content-Type:` and the part's
     * `Content-Transfer-Encoding: base64`, which only an attachment carries.
     */
    async function attachmentContentTypeLines(contentType: string): Promise<Array<string>> {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'a.txt', content: 'x', contentType }],
      });
      const lines = text.split('\r\n');
      const end = lines.indexOf('Content-Transfer-Encoding: base64');
      let start = end - 1;
      while (start > 0 && !lines[start].startsWith('Content-Type:')) {
        start--;
      }
      return lines.slice(start, end);
    }

    it('pins the rendered line for three of them', async () => {
      expect(await attachmentContentTypeLines('TEXT/PLAIN')).toEqual([
        'Content-Type: TEXT/PLAIN; name="a.txt"',
      ]);
      expect(await attachmentContentTypeLines('text/plain; charset="utf-8"')).toEqual([
        'Content-Type: text/plain; charset="utf-8"; name="a.txt"',
      ]);
      expect(await attachmentContentTypeLines('application/x-foo.bar-baz_1')).toEqual([
        'Content-Type: application/x-foo.bar-baz_1; name="a.txt"',
      ]);
    });

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": the `CONTENT_TYPE_LINE_OVERHEAD` guard
      // answers for an over-long value before the grammar reads it — the
      // stray `"` in here is never reached. ` <type>;` is the shortest line
      // the media type can fold onto, so 996 characters render exactly at
      // the 998-octet limit and 997 cannot.
      const error = await refused(`a/b"${'c'.repeat(2000)}`);
      expect(error.message).toBe(
        'attachment contentType is 2004 characters; at most 996 fit on the Content-Type line ' +
          'under the 998-octet limit in RFC 5322 §2.1.1. Shorten it.',
      );
      expect((await refused(`a/${'b'.repeat(995)}`)).message).toMatch(
        /^attachment contentType is 997 characters; at most 996 fit/,
      );
      const lines = await attachmentContentTypeLines(`a/${'b'.repeat(994)}`);
      expect(lines).toEqual(['Content-Type:', ` a/${'b'.repeat(994)};`, ' name="a.txt"']);
      expect(lines[1].length).toBe(998);
    });

    it("refuses a caller's name= parameter, which the builder sets from the filename", async () => {
      // `buildAttachmentPart` appends `name="<filename>"`, so a second one
      // would be the same parameter twice — RFC 6838 §4.3: "It is an error
      // for a specific parameter to be specified more than once."
      for (const contentType of ['text/plain; name=other', 'text/plain; NAME="other"']) {
        expect((await refused(contentType)).message).toBe(
          'attachment contentType must not carry a name= parameter; the builder adds name="<filename>" itself.',
        );
      }
    });

    it('refuses a parameter given twice, whatever its case (RFC 6838 §4.3)', async () => {
      // §5.1: "Matching of attributes is ALWAYS case-insensitive", and
      // §4.3 of RFC 6838 makes a repeat an error; a parser that keeps the
      // first and one that keeps the last would disagree on the message.
      for (const contentType of [
        'text/plain; a=b; a=c',
        'text/plain; charset=utf-8; CHARSET=ascii',
      ]) {
        expect((await refused(contentType)).message).toBe(
          'attachment contentType gives the same parameter twice; attribute names are case-insensitive and each may appear once (RFC 6838 §4.3).',
        );
      }
    });

    it('reports a syntax error ahead of a semantic one on the same parameter', async () => {
      // `name` without a value is a syntax error first.
      expect((await refused('text/plain; name')).message).toBe(SYNTAX);
    });
  });

  describe('Content-ID syntax of an attachment', () => {
    // `rejectControls` answered only for CTLs, and `buildAttachmentPart`
    // writes the Content-ID verbatim, adding `<` `>` unless the value
    // already starts with `<`: `logo other` rendered `<logo other>`,
    // `<logo` rendered `<logo` and `logo>` rendered `<logo>>` — captured as
    // a success under `void dev` and by the harness, and left for the
    // receiver to refuse or to fail the html's `cid:` reference against.
    // The grammar is RFC 5322 §3.6.4 `msg-id`, read as a generator, with
    // the `@` side and the brackets optional (RFC 2392 §2 resolves `cid:x`
    // against `<x>`, and the builder has always bracketed a bare id); the
    // message names the rule and never echoes the value.
    const base = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', html: '<img src="cid:logo">' };
    const SYNTAX =
      'attachment contentId is not a valid Content-ID (RFC 5322 §3.6.4 msg-id: an identifier of atext, "." and "@", optionally in one pair of angle brackets).';

    async function refused(contentId: string): Promise<MimeError> {
      let error: unknown;
      try {
        await normalizeEmail({
          ...base,
          attachments: [{ filename: 'logo.png', content: 'x', contentId }],
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(MimeError);
      expect((error as MimeError).code).toBe('MIME_ERROR');
      return error as MimeError;
    }

    /** The attachment part's rendered `Content-ID` line. */
    async function contentIdLine(contentId: string): Promise<string | undefined> {
      const { text } = await build({
        ...base,
        attachments: [{ filename: 'logo.png', content: 'x', contentId }],
      });
      return text.split('\r\n').find((line) => line.startsWith('Content-ID:'));
    }

    it('refuses one that does not parse, naming the rule rather than echoing it', async () => {
      const invalid = [
        'logo other', // WSP: rendered `<logo other>`
        '<logo', // unterminated: rendered `<logo`
        'logo>', // rendered `<logo>>`
        '<logo>>', //
        '<<logo>', //
        '<logo>x', // text after the closing bracket
        '<>', // brackets around nothing
        '<', //
        '>', //
        ' logo', // leading WSP
        'logo ', // trailing WSP
        'lo\tgo', // HTAB is WSP too (`rejectControls` lets it through)
        'lo"go', // `"` is not atext
        'lo(go)', // nor `(` `)`: an RFC 822 comment is refused, not stripped
        'lo,go', //
        'lo;go', //
        'lo:go', //
        'lo\\go', //
        'a@[127.0.0.1]', // `no-fold-literal` is left out
        'a..b', // `dot-atom-text` is 1*atext *("." 1*atext): no doubled dot
        '.a', // no leading dot
        'a.', // no trailing dot
        'a.@b', // nor on either side of the `@`
        'a@.b', //
        'a@b@c', // one `@` at most
        '@b', // an `@` owes both sides
        'a@', //
        'lögo', // atext is US-ASCII
        '', // used to be validated, then silently not rendered
      ];
      for (const contentId of invalid) {
        const error = await refused(contentId);
        expect(error.message, JSON.stringify(contentId)).toBe(SYNTAX);
        if (contentId.length > 0) {
          expect(error.message).not.toContain(contentId);
        }
      }
    });

    it('accepts every valid form and renders it as it did, byte for byte', async () => {
      // Bare or bracketed, the wire form is `<id>`; a bracketed id renders
      // as given, a bare one is wrapped — exactly what the unchecked path did.
      const valid: Array<[contentId: string, rendered: string]> = [
        ['logo', '<logo>'], // the documented example: no `@` (RFC 2392 §2)
        ['<logo>', '<logo>'],
        ['logo@example.com', '<logo@example.com>'], // a proper RFC 5322 msg-id
        ['<logo@example.com>', '<logo@example.com>'],
        ['a.b', '<a.b>'],
        ['a.b.c@d.e', '<a.b.c@d.e>'],
        ["!#$%&'*+-/=?^_`{|}~", "<!#$%&'*+-/=?^_`{|}~>"], // every atext symbol
        ['20240101.1234@mail.void.cloud', '<20240101.1234@mail.void.cloud>'],
        ['Logo-1_2', '<Logo-1_2>'], // case is kept as given
      ];
      for (const [contentId, rendered] of valid) {
        expect(await contentIdLine(contentId), contentId).toBe(`Content-ID: ${rendered}`);
      }
    });

    it('keeps the documented inline-image example working verbatim', async () => {
      const { text } = await build({
        from: 'Acme <acme+noreply@mail.void.cloud>',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<img src="cid:logo" alt="Acme">',
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
      expect(text).toContain('Content-ID: <logo>\r\n');
      expect(text).toContain('<img src="cid:logo" alt="Acme">');
    });

    it('still infers disposition from a bracketed id', async () => {
      // `att.contentId ? 'inline' : 'attachment'`: any id the grammar
      // admits is non-empty, so the default is `inline` for both forms.
      const email = await normalizeEmail({
        ...base,
        attachments: [
          { filename: 'a.png', content: 'x', contentId: 'a' },
          { filename: 'b.png', content: 'x', contentId: '<b>' },
        ],
      });
      expect(email.attachments.map((a) => a.disposition)).toEqual(['inline', 'inline']);
    });

    it('keeps the length bound in front of the scan', async () => {
      // "Bound before you scan": the `CONTENT_ID_LINE_OVERHEAD` guard
      // answers for an over-long value before the grammar reads it — the
      // space in here is never reached. `Content-ID: <id>` is one token,
      // so it never folds: a bare id of 984 characters renders exactly at
      // the 998-octet limit and 985 cannot; an id that brings its own
      // brackets is allowed those two characters more.
      const error = await refused(`x ${'x'.repeat(1998)}`);
      expect(error.message).toBe(
        'attachment contentId is 2000 characters; at most 984 fit on the Content-ID line ' +
          'under the 998-octet limit in RFC 5322 §2.1.1. Shorten it.',
      );
      expect((await refused('x'.repeat(985))).message).toMatch(
        /^attachment contentId is 985 characters; at most 984 fit/,
      );
      const bare = await contentIdLine('x'.repeat(984));
      expect(bare).toBe(`Content-ID: <${'x'.repeat(984)}>`);
      expect(bare!.length).toBe(998);
      expect((await refused(`<${'x'.repeat(985)}>`)).message).toMatch(
        /^attachment contentId is 987 characters; at most 986 fit/,
      );
      const bracketed = await contentIdLine(`<${'x'.repeat(984)}>`);
      expect(bracketed).toBe(`Content-ID: <${'x'.repeat(984)}>`);
      expect(bracketed!.length).toBe(998);
    });
  });

  describe('a colon in an address', () => {
    // `:` is an RFC 5322 §3.2.3 special, not `atext`, so a bare
    // `a:b@example.com` is no addr-spec without quoting — which is refused
    // too. It was the one special missing from the hand-written address
    // class: the address passed here, a handler's `forward()` recorded it,
    // and the platform router's `isValidEmailAddress` dropped that one
    // forward after earlier actions had fired. `email-validator` admits only
    // `atext`, so it is refused like `,` and `;`.
    const colons = ['a:b@example.com', 'a@b:c.example.com', ':a@example.com', 'a@example.com:'];

    it('refuses a bare address carrying one, with the code for its field', async () => {
      for (const bad of colons) {
        for (const [field, code] of [
          ['to', 'INVALID_TO'],
          ['from', 'INVALID_FROM'],
          ['cc', 'MIME_ERROR'],
          ['bcc', 'MIME_ERROR'],
          ['replyTo', 'MIME_ERROR'],
        ] as const) {
          let error: unknown;
          try {
            await normalizeEmail({
              from: 'a@x.dev',
              to: 'b@y.dev',
              [field]: bad,
              subject: 's',
              text: 't',
            });
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(MimeError);
          expect((error as MimeError).code).toBe(code);
          expect((error as MimeError).message).toBe(invalidAddress(field));
        }
      }
    });

    it('refuses it in the object and display-name forms on the same parsed address', async () => {
      for (const bad of colons) {
        await expect(
          normalizeEmail({
            from: 'a@x.dev',
            to: { name: 'Bob', email: bad },
            subject: 's',
            text: 't',
          }),
        ).rejects.toThrow(invalidAddress('to'));
        expect(() => parseAddress(`Bob <${bad}>`, 'to')).toThrow(invalidAddress('to'));
      }
    });

    it('still accepts one in a display name, where it is quoted', async () => {
      // A name is a phrase, and a phrase with a special is rendered as one
      // quoted-string — the address rule is not the name rule.
      const { text } = await build({
        from: 'a@x.dev',
        to: { name: 'Ops: Tier 2', email: 'b@y.dev' },
        subject: 's',
        text: 't',
      });
      expect(unfoldHeader(text, 'To')).toBe('"Ops: Tier 2" <b@y.dev>');
    });
  });

  describe('dot-atom shape of an address', () => {
    // An RFC 5322 §3.2.3 dot-atom cannot start or end with a dot or carry
    // two in a row, on either side of the `@`. The hand-written rule and
    // the platform router's regex BOTH accepted every one of these — no
    // divergence, just a shared hole that Cloudflare or the next MTA would
    // refuse after the handler's test had reported a success. One package
    // on both sides closes it.
    const dots = [
      'a..b@example.com',
      '.a@example.com',
      'a.@example.com',
      'a@example..com',
      'a@.example.com',
      'a@example.com.',
    ];

    it('refuses leading, trailing and doubled dots, with the code for its field', async () => {
      for (const bad of dots) {
        for (const [field, code] of [
          ['to', 'INVALID_TO'],
          ['from', 'INVALID_FROM'],
          ['cc', 'MIME_ERROR'],
          ['bcc', 'MIME_ERROR'],
          ['replyTo', 'MIME_ERROR'],
        ] as const) {
          let error: unknown;
          try {
            await normalizeEmail({
              from: 'a@x.dev',
              to: 'b@y.dev',
              [field]: bad,
              subject: 's',
              text: 't',
            });
          } catch (e) {
            error = e;
          }
          expect(error, bad).toBeInstanceOf(MimeError);
          expect((error as MimeError).code).toBe(code);
          expect((error as MimeError).message).toBe(invalidAddress(field));
        }
        expect(() => parseAddress(`Bob <${bad}>`, 'to')).toThrow(invalidAddress('to'));
      }
    });

    it('still accepts dots between atoms, on both sides', async () => {
      for (const ok of [
        'first.last@example.com',
        'a.b.c@sub.example.co.uk',
        'a@sub.sub.example.com',
      ]) {
        const email = await normalizeEmail({ from: ok, to: ok, subject: 's', text: 't' });
        expect(email.to[0].email).toBe(ok);
      }
    });
  });

  describe('domain and local-part characters of an address', () => {
    // The package's domain rule: ASCII labels, and a TLD that starts with a
    // letter and is at least two characters. A quoted local part and a
    // display name in the bare string stay refused, as they always were.
    it('applies the TLD rule', async () => {
      for (const bad of ['a@b.c', 'a@b.1c', 'a@b.c-', 'a@b.-c']) {
        await expect(
          normalizeEmail({ from: 'a@x.dev', to: bad, subject: 's', text: 't' }),
        ).rejects.toThrow(invalidAddress('to'));
      }
      for (const ok of [
        'a@b.c1',
        'a@b.co',
        'a@b.c-d',
        'a@xn--bcher-kva.example',
        'a@b-c.example',
      ]) {
        const email = await normalizeEmail({ from: 'a@x.dev', to: ok, subject: 's', text: 't' });
        expect(email.to[0].email).toBe(ok);
      }
    });

    it('refuses a raw IDN domain and a quoted local part', async () => {
      for (const bad of [
        'a@exämple.com',
        '"a b"@example.com',
        '"a@b"@example.com',
        '"weird"@x.dev',
      ]) {
        await expect(
          normalizeEmail({ from: 'a@x.dev', to: bad, subject: 's', text: 't' }),
        ).rejects.toThrow(invalidAddress('to'));
      }
    });

    it('pins the package quirk: a backtick may not be the FIRST local-part character', async () => {
      // The first character class of `email-validator`'s regex lacks the
      // backtick that every later class has. Pinned, not worked around: the
      // point of one package on both sides is that the rule is whatever the
      // package says, and a wrapper that patched this would be the start of
      // the next hand-written rule.
      await expect(
        normalizeEmail({ from: 'a@x.dev', to: '`a@x.com', subject: 's', text: 't' }),
      ).rejects.toThrow(invalidAddress('to'));
      const email = await normalizeEmail({
        from: 'a@x.dev',
        to: 'a`b@x.com',
        subject: 's',
        text: 't',
      });
      expect(email.to[0].email).toBe('a`b@x.com');
    });

    it('accepts every RFC 5322 atext punctuation after the first character', async () => {
      const atext = "!#$%&'*+-/=?^_`{|}~";
      const ok = `a${atext}@example.com`;
      const email = await normalizeEmail({ from: 'a@x.dev', to: ok, subject: 's', text: 't' });
      expect(email.to[0].email).toBe(ok);
    });
  });

  it('parses the display-name form in linear time', () => {
    // `^\s*([^"<]+?)?\s*<` let three quantifiers share one run of
    // whitespace; the backtracker tried every split, cubic in the run.
    // Measured on that form: 2,000 spaces took 2 s, 4,000 took 10 s (16 s
    // when the `>` is missing). A regex cannot be interrupted, so keep the
    // run where a regression costs seconds, not the test's whole timeout.
    // (Two-letter TLDs: the address rule wants at least two.)
    const run = ' '.repeat(4000);
    const started = performance.now();
    expect(parseAddress(`${run}a@b.cd`, 'to')).toEqual({ email: 'a@b.cd' });
    expect(() => parseAddress(`${run}<a@b.cd`, 'to')).toThrow(MimeError);
    expect(parseAddress(`\t${run}Name${run}<a@b.cd>${run}`, 'to')).toEqual({
      email: 'a@b.cd',
      name: 'Name',
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps the display-name form’s language after the regex change', () => {
    // Shapes the old and new patterns were checked to agree on
    // (exhaustively to length 7 over a 9-symbol alphabet); pinned here.
    expect(parseAddress('a>b <c@d.ef>', 'to')).toEqual({ email: 'c@d.ef', name: 'a>b' });
    expect(parseAddress('x<a@b.cd>', 'to')).toEqual({ email: 'a@b.cd', name: 'x' });
    expect(parseAddress('\tJohn\tSmith\t<j@s.ef>', 'to')).toEqual({
      email: 'j@s.ef',
      name: 'John\tSmith',
    });
    expect(parseAddress('   <a@b.cd>   ', 'to')).toEqual({ email: 'a@b.cd' });
    expect(() => parseAddress('a"b <c@d.ef>', 'to')).toThrow(MimeError);
    expect(() => parseAddress('a <b@c.d> e', 'to')).toThrow(MimeError);
    expect(() => parseAddress('<a b@c.d>', 'to')).toThrow(MimeError);
  });

  it('undoes quoted-pairs in a quoted display name, and only there', () => {
    // RFC 5322 §3.2.4: inside a quoted-string `"` and `\` appear only as
    // `\"` and `\\`, and `\x` is `x` for any other `x`. The parsed name is
    // what `formatAddress` quotes and escapes again, so it has to be the
    // raw text — what the object form carries — or the escapes render
    // twice and the recipient sees the backslashes.
    expect(parseAddress('"Smith \\"Bob\\"" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: 'Smith "Bob"',
    });
    expect(parseAddress('"a\\\\b" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'a\\b' });
    expect(parseAddress('"ab\\\\" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'ab\\' });
    expect(parseAddress('"a\\xb" <a@x.dev>', 'to')).toEqual({ email: 'a@x.dev', name: 'axb' });
    // UTF-16 code units, surrogate pairs included.
    expect(parseAddress('"\\"😀 \\\\ ï" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: '"😀 \\ ï',
    });
    // A quoted name with no backslash is untouched, and a backslash in an
    // UNQUOTED name is a character like any other — as in the object form.
    expect(parseAddress('"Smith, John" <a@x.dev>', 'to')).toEqual({
      email: 'a@x.dev',
      name: 'Smith, John',
    });
    expect(parseAddress('a\\b <c@d.ef>', 'to')).toEqual({ email: 'c@d.ef', name: 'a\\b' });
    // `\@` is still an `@` in a display name, which is still refused.
    expect(() => parseAddress('"a\\@x" <b@y.dev>', 'to')).toThrow(/must not contain '@'/);
    // The quoted-string line guard sees the DECODED name, the one
    // `formatAddress` renders: 500 pairs are 1,000 raw characters (over
    // the guard) but a 500-character name (under it), and the count the
    // error reports is the decoded one.
    expect(parseAddress(`"${'\\"'.repeat(500)}" <a@x.dev>`, 'to').name).toBe('"'.repeat(500));
    expect(() => parseAddress(`"${'\\"'.repeat(996)}" <a@x.dev>`, 'to')).toThrow(
      /display name is 996 characters and must be quoted/,
    );
  });

  it('undoes quoted-pairs in linear time and without a per-pair allocation', () => {
    // A `replace(/\\(.)/g, '$1')` holds about 60 bytes of heap per match
    // before it builds its result — measured 307 MB for 10 MiB of `\"`
    // pairs, past a 128 MB isolate — and nothing bounds the name before
    // the decode runs: an ASCII name is bounded only on its DECODED form,
    // and a non-ASCII one never is. The buffer routine peaked at 49 MB on
    // the same input. Heap is not something a test can pin; time is, and
    // both shapes are exercised so the output of each path is built.
    const started = performance.now();
    expect(() => parseAddress(`"${'\\"'.repeat(1_000_000)}" <a@x.dev>`, 'to')).toThrow(
      /cannot be folded/,
    );
    const nonAscii = parseAddress(`"${'\\"é'.repeat(500_000)}" <a@x.dev>`, 'to');
    expect(nonAscii.name).toHaveLength(1_000_000);
    expect(nonAscii.name!.startsWith('"é"é')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
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

  // The encoding decision, pinned: only LF and CRLF end a line, a bare CR
  // (or any other control character) forces quoted-printable, and a line of
  // 990 printable characters is the longest that ships as 7bit. Captured
  // from the regex-and-split implementation the one-pass scanner replaced.
  it.each<[string, string, string, string]>([
    ['a bare CR', 'a\rb', 'quoted-printable', 'a\r\nb'],
    ['a tab', 'a\tb', 'quoted-printable', 'a\tb'],
    ['DEL', 'a\x7fb', 'quoted-printable', 'a=7Fb'],
    ['a 990-character line', 'a'.repeat(990), '7bit', 'a'.repeat(990)],
    [
      'a 991-character line',
      'a'.repeat(991),
      'quoted-printable',
      `${'a'.repeat(75)}=\r\n`.repeat(13) + 'a'.repeat(16),
    ],
    [
      'two 990-character lines split by a bare LF',
      `${'a'.repeat(990)}\n${'b'.repeat(990)}`,
      '7bit',
      `${'a'.repeat(990)}\r\n${'b'.repeat(990)}`,
    ],
    ['a mix of LF and CRLF', 'l1\nl2\r\nl3\n', '7bit', 'l1\r\nl2\r\nl3\r\n'],
  ])('encodes %s as %s', async (_what, input, encoding, expected) => {
    const { text } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: input });
    expect(text).toContain(`Content-Transfer-Encoding: ${encoding}`);
    expect(bodyOf(text)).toBe(expected);
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

  it('renders a quoted display name with its quoted-pairs escaped exactly once', async () => {
    // `"Smith \"Bob\"" <a@x.dev>` used to keep the raw `\"` pairs in the
    // parsed name, and `formatAddress` escaped them again: the header read
    // `"Smith \\\"Bob\\\""` and the recipient saw `Smith \"Bob\"`. The
    // object form of the same name was right, so the two forms disagreed.
    const cases: Array<[string, string, string]> = [
      ['"Smith \\"Bob\\"" <a@x.dev>', 'Smith "Bob"', '"Smith \\"Bob\\""'],
      ['"a\\\\b" <a@x.dev>', 'a\\b', '"a\\\\b"'],
      ['"ab\\\\" <a@x.dev>', 'ab\\', '"ab\\\\"'],
      ['"Smith, John" <a@x.dev>', 'Smith, John', '"Smith, John"'],
      ['"a\\xb" <a@x.dev>', 'axb', 'axb'],
    ];
    for (const [from, name, rendered] of cases) {
      const viaString = await build({ from, to: 'b@y.dev', subject: 's', text: 't' });
      const viaObject = await build({
        from: { email: 'a@x.dev', name },
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(unfoldHeader(viaString.text, 'From')).toBe(`${rendered} <a@x.dev>`);
      expect(unfoldHeader(viaObject.text, 'From')).toBe(`${rendered} <a@x.dev>`);
      // Read the quoted-string back the way a receiver does.
      const m = unfoldHeader(viaString.text, 'From').match(/^"((?:[^"\\]|\\.)*)" </);
      if (m) {
        expect(m[1].replace(/\\(.)/g, '$1')).toBe(name);
      }
    }
    // A non-ASCII name becomes encoded-words rather than a quoted-string;
    // the decoded text is what gets encoded.
    const { text } = await build({
      from: '"\\"😀\\\\ ï" <a@x.dev>',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
    });
    expect(decodeEncodedWords(unfoldHeader(text, 'From'))).toBe('"😀\\ ï <a@x.dev>');
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
    // The projection must let it through; the post-render check must reject
    // it. One full ~10 MB render, so it carries its own timeout (0.4 s here,
    // several times that on a loaded CI runner).
    const nearly = '漢'.repeat(Math.ceil((3.3 * 1024 * 1024) / 3));
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: nearly,
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a body the projection accepts builds; the size that fits is not
    // at issue, so keep this one small.
    const fits = '漢'.repeat(20_000);
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: fits });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  }, 30_000);
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

  // A custom header's NAME is rendered verbatim too, and `normalizeEmail`
  // bounds one name at under a kilobyte — not the sum, nor the count. With
  // empty values the names and the `: ` CRLF around each are the whole
  // message, and none of it was charged: 60k empty headers with
  // 500-character names — a 30 MB message — projected to zero, rendered in
  // full and peaked at 121 MB of a 128 MB isolate (measured, 240 ms); 100k
  // of them went to 169 MB. Every name and its framing is charged now, so
  // the same set is refused before a line is built (98 ms, 67 MB peak).
  it('counts every custom header name and the framing around it', async () => {
    const names = (count: number, len: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`X${i}`.padEnd(len, 'a'), '']));
    const started = performance.now();
    // 22k names of 500 characters: 11 MB of names, nothing else.
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: names(22_000, 500),
    });
    // 31 ms measured; the bound leaves room for a loaded CI runner.
    expect(performance.now() - started).toBeLessThan(2000);
    // The bound is exact for a header with an empty value: 10,485 names of
    // 996 characters project 745 octets under the cap and render 548 under
    // it, so they build. One more 600-character name projects 141 under
    // and renders 57 over, so the post-render check — not the projection —
    // must be the one to refuse it. One more 996-character name is over
    // by projection alone.
    const fits = names(10_485, 996);
    const { raw } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: fits,
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    await expect(
      build({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        headers: { ...fits, ['Y'.padEnd(600, 'a')]: '' },
      }),
    ).rejects.toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      headers: names(10_486, 996),
    });
  }, 30_000);

  // The runner's own heap is not capped, so the pin runs the projection in
  // a child with the isolate's cap. 60k empty headers with 996-character
  // names are 60 MB of names the caller already holds; rendering them held
  // the folded lines, their join and `rawText` beside the names — three
  // copies, 180 MB live — and died with `FATAL ERROR: Reached heap limit`
  // before the size check (measured). The projection refuses them at an
  // 88 MB peak, in 173 ms.
  it('refuses 60 MB of header names inside a 128 MB heap', () => {
    const mimeModule = pathToFileURL(
      join(import.meta.dirname, '../../src/runtime/email/mime.ts'),
    ).href;
    const child = `
      const { normalizeEmail, buildMime } = await import(process.argv[1]);
      const headers = {};
      for (let i = 0; i < 60_000; i++) headers['X' + i + 'a'.repeat(996 - 1 - String(i).length)] = '';
      const t0 = performance.now();
      const email = await normalizeEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't', headers });
      let error;
      try { buildMime(email); } catch (e) { error = e; }
      console.log(JSON.stringify({ code: error?.code, message: error?.message, ms: performance.now() - t0 }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', child, mimeModule],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      code?: string;
      message?: string;
      ms: number;
    };
    expect(result.code).toBe('MIME_ERROR');
    expect(result.message).toMatch(PROJECTION);
    // 173 ms measured locally; the bound leaves room for CI's slower runner
    // (about 6x), where the old shape did not finish at all.
    expect(result.ms).toBeLessThan(5000);
  }, 30_000);

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

  // `replyEmail` threads `In-Reply-To` and `References` straight off the
  // INBOUND message, so a remote sender controls them up to the whole raw
  // message. They are rendered verbatim — never `encodeWord`ed — but folded
  // and joined like any other header, so an oversized chain was rendered in
  // full before the post-render check saw it.
  it('counts the threading headers', async () => {
    // 900k twelve-character ids: 10.8 MB of non-WSP before a single space.
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      threading: { references: '<abcdefgh@x> '.repeat(900_000).trimEnd() },
    });
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      threading: { inReplyTo: `<${'x'.repeat(11 * 1024 * 1024)}@x>` },
    });
  });

  // An attachment part's own headers are built outside `foldHeader`'s
  // encoded path: `Content-Type: <contentType>; name="<filename>"`,
  // `Content-Disposition: <disposition>; filename="<filename>"` and
  // `Content-ID: <contentId>`. Each of the three values is charged, and
  // each is now also bounded per attachment in `normalizeAttachment` (see
  // 'media type syntax of an attachment' and 'Content-ID syntax of an
  // attachment'), so none reaches the projection over-long through
  // `normalizeEmail`. The charge stays — `buildMime` is the authority on
  // the final size, whatever handed it the email — so it is pinned on a
  // hand-built `NormalizedEmail`, as the attachment-count test is.
  it('counts an attachment Content-ID, even though normalizeAttachment now bounds it', () => {
    const over = 'x'.repeat(11 * 1024 * 1024);
    expect(() =>
      buildMime({
        from: { email: 'a@x.dev' },
        to: [{ email: 'b@y.dev' }],
        cc: [],
        bcc: [],
        subject: 's',
        text: 'hi',
        headers: {},
        attachments: [
          {
            filename: 'f.txt',
            contentType: 'text/plain',
            bytes: new Uint8Array(1),
            contentId: over,
            disposition: 'inline',
          },
        ],
      }),
    ).toThrow(PROJECTION);
  });

  // `normalizeAttachment` bounds ONE filename at 986 characters, not the
  // sum, and nothing bounds the part count: 50k zero-byte attachments with
  // legal filenames are a 106 MB message — each filename rendered twice,
  // inside 117 octets of boundary and framing — that was held three to
  // four times over between the parts, their join, `rawText` and `raw`,
  // and terminated a 128 MB isolate before the final size check. Every
  // part is charged its filename twice plus that framing.
  it('counts every attachment part: its filename twice, and the framing around it', async () => {
    const filename = 'a'.repeat(986);
    const empty = new Uint8Array(0);
    const parts = (n: number) =>
      Array.from({ length: n }, () => ({ filename, contentType: 'a/b', content: empty }));
    await expectProjected({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: parts(50_000),
    });
    // The bound is exact for a part with no content: 5,012 parts project to
    // 640 octets under the cap and render to 10.66 MB, so the post-render
    // check — not the projection — must be the one to refuse them.
    await expect(
      build({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't', attachments: parts(5_012) }),
    ).rejects.toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And 4,900 parts, a 10.42 MB message, build.
    const { raw } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 't',
      attachments: parts(4_900),
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it('never rejects a References chain that fits, and never charges the whitespace it folds away', async () => {
    // A 5 MB chain of short ids is a legal message: it folds at its spaces
    // into 76-column lines and renders under the cap.
    const id = '<abcdefgh@x>';
    const chain = Array.from({ length: Math.floor((5 * 1024 * 1024) / (id.length + 1)) }, () => id);
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      threading: { references: chain.join(' ') },
    });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(unfoldHeader(text, 'References')).toBe(chain.join(' '));
    // A long chain is re-joined from its ids by single spaces, so 11 MiB of
    // spaces between two ids renders as one; a bound that charged them
    // would reject a message that fits.
    const spaced = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'hi',
      threading: { references: `<a@x>${' '.repeat(11 * 1024 * 1024)}<b@x>` },
    });
    expect(spaced.text).toContain('References: <a@x> <b@x>\r\n');
  });

  it('never rejects a header-heavy message that fits, and leaves the final check as the authority', async () => {
    // 2.15M CJK characters project to ~10.32 MiB (4.8 octets each: the bound
    // omits the fold's CRLF per word) but render to ~10.75 MB at 5 octets
    // each. The projection must let it through; the post-render check must
    // reject it. This is the one case that needs a full ~10 MB render (the
    // property is AT the boundary), so it carries its own timeout: 0.8 s
    // here, 5.4 s on a loaded 4-vCPU CI runner.
    const nearly = '漢'.repeat(2_150_000);
    const email = await normalizeEmail({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: nearly,
      text: 'hi',
    });
    expect(() => buildMime(email)).toThrow(/message size \d+ bytes exceeds Cloudflare limit/);
    // And a subject the projection accepts builds; the size that fits is
    // not at issue, so keep this one small.
    const fits = '漢'.repeat(20_000);
    const { raw } = await build({ from: 'a@x.dev', to: 'b@y.dev', subject: fits, text: 'hi' });
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  }, 30_000);
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

describe('body line scan memory', () => {
  // A legal 6 MB body of 3M two-character lines — pasted logs, say — renders
  // to 9 MB. The encoding decision used to strip every line break with a
  // global `replace` and `split` the body into an array of lines, the 7bit
  // path re-joined it with another global `replace` (V8 keeps two or three
  // parts-array slots per match), and the post-render line check `split`
  // the whole message again: 240 MB of heap, all of it per LINE and
  // invisible to any size projection, on a message that fit a 128 MB
  // isolate four times over. Every pass is now one `charCodeAt` scan and
  // the 7bit body is written into a buffer of its own size (measured, 32
  // MB). The memory bound is measured, not asserted, because the test
  // runner's heap is not the isolate's; this pins the rendered shape and
  // that the scans stay linear.
  it('builds a legal message of millions of short lines in text and html', async () => {
    const lines = 1_500_000;
    const started = performance.now();
    const { raw, text } = await build({
      from: 'a@x.dev',
      to: 'b@y.dev',
      subject: 's',
      text: 'a\n'.repeat(lines),
      html: '\n'.repeat(lines),
    });
    // A gross-regression guard only: the previous code died here, it did not
    // slow down. 0.2 s locally; a loaded CI runner is several times slower.
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(raw.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(raw.byteLength).toBeGreaterThan(lines * 5);
    expect(text).toContain(`Content-Transfer-Encoding: 7bit\r\n\r\n${'a\r\n'.repeat(lines)}`);
    expect(text).toContain(`Content-Transfer-Encoding: 7bit\r\n\r\n${'\r\n'.repeat(lines)}`);
    // Every LF in the message is the LF of a CRLF.
    expect(text).not.toMatch(/(^|[^\r])\n/);
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
