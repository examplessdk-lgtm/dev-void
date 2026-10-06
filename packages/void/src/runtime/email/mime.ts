/**
 * Minimal RFC 5322 / 2047 / 2045 MIME builder for the void/email runtime.
 *
 * Scope is intentionally narrow — text/plain, text/html, multipart/alternative,
 * and multipart/mixed for attachments — covering >95% of transactional sends.
 * Inline images use multipart/related when both attachments and html are present.
 */

import { validate as isValidEmailSyntax } from 'email-validator';
import type { Address, Attachment, NormalizedAttachment, NormalizedEmail } from './types.ts';

/** Encoded outbound MIME ceiling, separate from the 10 MiB inbound limit. */
export const MAX_MESSAGE_BYTES: number = 5 * 1024 * 1024;

/**
 * Upper bound on the TOTAL attachment bytes `normalizeEmail` will materialize.
 *
 * Base64 expands by `ceil(n / 3) * 4`, so an attachment set larger than three
 * quarters of `MAX_MESSAGE_BYTES` cannot fit in a message that passes the
 * check at the end of `buildMime` no matter how small everything else is.
 * `buildMime` remains the authority on the final size — this bound only stops
 * `normalizeEmail` from materializing, and then expanding, bytes already known
 * not to fit.
 *
 * It has to be charged here because that final check comes far too late to
 * help. Measured peak live memory is about 10x the attachment bytes (8 MiB in
 * gives 83 MiB live) once the normalized copy, the base64 binary string, the
 * 76-column slices, the joins, `rawText` and its `TextEncoder.encode` are all
 * resident at once. Against a 128 MB isolate ceiling, a set over roughly
 * 12 MiB terminates the isolate rather than returning the `MIME_ERROR` the
 * docs promise for an oversize payload.
 *
 * This is a developer-experience guardrail, NOT the security boundary.
 * Attachments come from the app's own code, never from a remote sender, and
 * the platform proxy already caps the base64 length before decoding and the
 * raw length after. What this buys is a precise, catchable failure at the call
 * that went wrong, instead of a dead isolate with nothing a caller could act
 * on.
 */
const MAX_ATTACHMENT_BYTES_TOTAL: number = Math.floor((MAX_MESSAGE_BYTES * 3) / 4);

/**
 * Bound raw `to`, `cc`, and `bcc` entries before parsing or rendering headers.
 * Counting before deduplication also bounds work for duplicate-heavy input.
 * The same SDK limit applies in development and on both deployment targets;
 * platform admission independently caps the unique recipients at 50.
 */
export const MAX_RECIPIENTS: number = 50;

/** Maximum serialized size of app-defined top-level MIME fields. */
const MAX_CUSTOM_HEADER_BYTES: number = 16 * 1024;

/**
 * Pre-parse cap on one parsed address, in characters. RFC 5321 §4.5.3.1
 * allows a 64-octet local part and a 255-octet domain, so nothing over 320
 * characters can be delivered; the platform proxy applies the same
 * `MAX_RECIPIENT_LENGTH` to the same parsed address. This is the bound on
 * the WORK — it is checked before the address is scanned — not the
 * deliverability bound, which `email-validator` applies at 254 (see
 * `validateAddressParts`). A display name is not bounded — it is folded or
 * encoded into legal header lines at any length, and the tokenizers below
 * keep that cost linear.
 */
export const MAX_ADDRESS_LENGTH: number = 320;

const CRLF = '\r\n';
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const HEADER_NAME = /^[!-9;-~]+$/;

function rejectCRLF(field: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x0d || c === 0x0a || c === 0x00) {
      throw new MimeError('MIME_ERROR', `${field}: must not contain CR, LF, or NUL.`);
    }
  }
}

/**
 * Refuse any other C0 control or DEL in a value that is rendered VERBATIM
 * into a header — an attachment's filename, media type and Content-ID.
 * `rejectCRLF` is enough for a value `encodeWord` renders (the subject, a
 * custom header value, a display name): anything outside printable ASCII
 * sends the whole value into base64, so a control never reaches the wire.
 * These three go through `quoteParam` or straight into the line, so a
 * control would reach the wire for the receiving MTA to refuse.
 *
 * RFC 5322 §3.2.4 `qtext` is printable US-ASCII less `"` and `\`; a
 * control inside a quoted-string is `obs-qtext`, which §4 says MUST NOT be
 * generated. HTAB is deliberately NOT refused: `quoted-string` is
 * `DQUOTE *([FWS] qcontent) [FWS] DQUOTE` and `FWS` is built from `WSP`
 * (SP / HTAB), so a tab between characters is folding white space exactly
 * as a space is — and `obs-NO-WS-CTL`, the RFC's own list of the controls
 * that used to be `qtext`, leaves %d9 out. The same set is illegal in an
 * RFC 2045 §5.1 `token` (no CTLs) and an RFC 5322 §3.6.4 `msg-id`
 * (`dot-atom-text`), so one rule serves the media type and the Content-ID.
 *
 * The message names the code point and never echoes the value, as
 * `validateAddressParts` does. Runs AFTER the filename's length bound, so
 * the scan is over a value already known to fit a line.
 */
function rejectControls(field: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      throw new MimeError(
        'MIME_ERROR',
        `${field} contains a control character (U+${c.toString(16).toUpperCase().padStart(4, '0')}).`,
      );
    }
  }
}

/** RFC 2045 §5.1 `tspecials`: what a `token` may not contain besides SPACE and CTLs. */
const TSPECIALS = '()<>@,;:\\"/[]?=';

/** RFC 2045 §5.1 `token` character: printable US-ASCII less SPACE and `tspecials`. */
function isTokenChar(c: number): boolean {
  return c > 0x20 && c < 0x7f && !TSPECIALS.includes(String.fromCharCode(c));
}

/**
 * Refuse an attachment media type that does not parse as RFC 2045 §5.1
 * `type "/" subtype *(";" parameter)`.
 *
 * `rejectControls` answers only for CTLs, and `buildAttachmentPart` writes
 * the value verbatim ahead of its own `; name="…"`, so an unterminated
 * quote such as `text/plain; x="` would swallow the builder's `name`
 * parameter as the value of `x`.
 *
 * The grammar is the RFC's, read as a generator: a `token` is printable
 * US-ASCII less SPACE and `tspecials`; a `value` is a `token` or a
 * quoted-string, whose content is anything but a bare `"` or `\` (the same
 * rule `quoteParam` renders `name="…"` by, so a caller's quoted value may
 * carry what the builder's own already does). Optional WSP is admitted on
 * either side of `;` — the RFC 822 implicit LWSP every parser accepts and
 * the form HTTP's `Content-Type` writes — and nowhere else: `text/ plain`,
 * a trailing `;`, and an RFC 822 comment are refused rather than repaired.
 * Two parameters are also refused on their meaning: a `name`, because the
 * builder appends `name="<filename>"` and RFC 6838 §4.3 makes it "an error
 * for a specific parameter to be specified more than once"; and by that
 * same sentence any attribute given twice, compared case-insensitively as
 * §5.1 says attributes match. Type and subtype are kept as given — matching
 * is case-insensitive, so `TEXT/PLAIN` is legal and renders unchanged.
 *
 * One pass, no backtracking, and the only allocation is one lower-cased
 * attribute per parameter for the duplicate check, which is why this runs
 * AFTER the value's length bound. The message names the rule and never
 * echoes the value.
 */
function validateMediaType(field: string, value: string): void {
  const syntax = () =>
    new MimeError(
      'MIME_ERROR',
      `${field} is not a valid media type (RFC 2045 §5.1: type/subtype, then ; attribute=value parameters).`,
    );
  const n = value.length;
  let i = 0;
  /** Advance over a `token`; the number of characters consumed. */
  const token = (): number => {
    const start = i;
    while (i < n && isTokenChar(value.charCodeAt(i))) {
      i++;
    }
    return i - start;
  };
  const wsp = (): void => {
    while (i < n && (value[i] === ' ' || value[i] === '\t')) {
      i++;
    }
  };
  if (token() === 0 || value[i] !== '/') {
    throw syntax();
  }
  i++;
  if (token() === 0) {
    throw syntax();
  }
  const seen = new Set<string>();
  while (i < n) {
    wsp();
    if (value[i] !== ';') {
      throw syntax();
    }
    i++;
    wsp();
    const start = i;
    if (token() === 0 || value[i] !== '=') {
      throw syntax();
    }
    const attribute = value.slice(start, i).toLowerCase();
    i++;
    if (value[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) {
          throw syntax();
        }
        const ch = value[i++];
        if (ch === '"') {
          break;
        }
        if (ch === '\\') {
          if (i >= n) {
            throw syntax();
          }
          i++;
        }
      }
    } else if (token() === 0) {
      throw syntax();
    }
    if (attribute === 'name') {
      throw new MimeError(
        'MIME_ERROR',
        `${field} must not carry a name= parameter; the builder adds name="<filename>" itself.`,
      );
    }
    if (seen.has(attribute)) {
      throw new MimeError(
        'MIME_ERROR',
        `${field} gives the same parameter twice; attribute names are case-insensitive and each may appear once (RFC 6838 §4.3).`,
      );
    }
    seen.add(attribute);
  }
}

/** RFC 5322 §3.2.3 `atext` besides ALPHA and DIGIT. */
const ATEXT_SYMBOLS = "!#$%&'*+-/=?^_`{|}~";

/** RFC 5322 §3.2.3 `atext` character. */
function isAtext(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    ATEXT_SYMBOLS.includes(String.fromCharCode(c))
  );
}

/**
 * Refuse an attachment Content-ID that would not render as one RFC 5322
 * §3.6.4 `msg-id`.
 *
 * `rejectControls` answers only for CTLs, and `buildAttachmentPart` writes
 * the value verbatim — adding `<` and `>` unless the value already starts
 * with `<` — so a malformed id would reach the receiver and break the
 * `cid:` reference.
 *
 * The grammar is the RFC's, read as a generator, with two deliberate
 * differences. An `msg-id` is `"<" id-left "@" id-right ">"`, each side a
 * `dot-atom-text` (§3.2.3: `1*atext *("." 1*atext)`, so no leading,
 * trailing or doubled dot — the strict form; `obs-id-left`/`obs-id-right`
 * are §4 obsolete syntax, which MUST NOT be generated); `no-fold-literal`
 * (`[…]` for `id-right`) is left out. First difference: the `@` and its
 * right side are OPTIONAL. RFC 2392 §2 resolves a `cid:` URL by wrapping
 * its body in `<` `>` and matching that against `Content-ID`, so an id
 * without `@` — the documented `contentId: 'logo'` + `cid:logo` — is what
 * every client already resolves, and the domain that would make it a
 * proper `msg-id` adds nothing a reference could use. Second: the angle
 * brackets are optional too, because the builder has always added them
 * around a bare id; given, they must be one pair around the whole value.
 *
 * Refused, then: whitespace of any kind, a second `@`, `<` or `>` anywhere
 * but as that one pair, `"`, `(`, `)`, `,`, `;`, `:`, `\`, `[`, `]`,
 * anything non-ASCII, and the empty string.
 *
 * One pass, no allocation, which is why this runs AFTER the value's length
 * bound. The message names the rule and never echoes the value.
 */
function validateContentId(field: string, value: string): void {
  const syntax = () =>
    new MimeError(
      'MIME_ERROR',
      `${field} is not a valid Content-ID (RFC 5322 §3.6.4 msg-id: an identifier of atext, "." and "@", optionally in one pair of angle brackets).`,
    );
  let i = 0;
  let end = value.length;
  if (value[0] === '<') {
    if (end < 2 || value[end - 1] !== '>') {
      throw syntax();
    }
    i = 1;
    end--;
  }
  /** Advance over a `dot-atom-text`; false when there is none, or a dot is misplaced. */
  const dotAtomText = (): boolean => {
    let run = 0; // atext since the last dot
    for (; i < end; i++) {
      const c = value.charCodeAt(i);
      if (isAtext(c)) {
        run++;
      } else if (c === 0x2e /* . */ && run > 0) {
        run = 0;
      } else {
        break;
      }
    }
    return run > 0;
  };
  if (!dotAtomText()) {
    throw syntax();
  }
  if (i < end) {
    if (value[i] !== '@') {
      throw syntax();
    }
    i++;
    if (!dotAtomText()) {
      throw syntax();
    }
  }
  if (i !== end) {
    throw syntax();
  }
}

const COMMON_TYPES: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  ics: 'text/calendar',
  eml: 'message/rfc822',
};

function inferContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return COMMON_TYPES[ext] ?? 'application/octet-stream';
}

export type MimeErrorCode = 'INVALID_FROM' | 'INVALID_TO' | 'MIME_ERROR';

export class MimeError extends Error {
  code: MimeErrorCode;
  constructor(code: MimeErrorCode, message: string) {
    super(message);
    this.name = 'MimeError';
    this.code = code;
  }
}

function fieldErrorCode(field: string): MimeErrorCode {
  if (field === 'from') {
    return 'INVALID_FROM';
  }
  if (field === 'to') {
    return 'INVALID_TO';
  }
  return 'MIME_ERROR';
}

/**
 * Validate one parsed address (and its display name, when there is one),
 * throwing a `MimeError` for `field` on anything undeliverable. Exported so
 * the inbound proxy's `forward(to)` and hand-built `reply()` refuse a bare
 * address by the same rule `sendEmail` applies to its `to`.
 *
 * The address rule is `email-validator`, and nothing else. It is also the
 * platform router's rule (`isValidEmailAddress` in the proxy's
 * `email-router.ts`), so there is exactly ONE address syntax in the tree:
 * an action the framework records is never dropped by the router for its
 * shape, and a test harness never captures as a success what the managed
 * deployment would lose.
 *
 * What it enforces: at most 254 characters in total; an ASCII dot-atom
 * local part of at most 64 characters (RFC 5322 §3.2.3 `atext`, dots only
 * between atoms — no quoted local part, no whitespace, no control, no
 * special); a dotted domain of ASCII labels of at most 63 characters each,
 * with a TLD that starts with a letter and has at least two characters; so
 * `user@localhost`, `x@y` and a raw IDN or SMTPUTF8 address are refused
 * (an IDN domain is accepted as punycode, `xn--…`). ASCII-only makes
 * octets and characters the same thing, so the RFC 5321 §4.5.3.1 octet
 * limits are the package's length checks; the 64 is also what caps the
 * default `<slug>+noreply@` sender (`VALID_SLUG` in `runtime/email.ts`,
 * `MAX_SLUG_LENGTH` = `64 - 8` in `cli/project-slug.ts` and the API). One
 * known quirk, pinned in the tests rather than worked around: the FIRST
 * character of the local part may not be a backtick, while any later one
 * may.
 *
 * `MAX_ADDRESS_LENGTH` still runs first, on the raw string, so the scan is
 * bounded before anything reads the address; the package's own 254 check
 * runs before its regex for the same reason. The message never echoes the
 * address: it may hold a control character, and naming the rule is enough.
 */
export function validateAddressParts(field: string, email: string, name?: string): void {
  if (email.length > MAX_ADDRESS_LENGTH) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: address is ${email.length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit.`,
    );
  }
  if (!isValidEmailSyntax(email)) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: address is not a valid email address (ASCII local part and dotted domain, ` +
        `RFC 5322 dot-atom; at most 64 characters before the '@' and 254 in total).`,
    );
  }
  if (name !== undefined) {
    rejectCRLF(`${field} display name`, name);
    // An ASCII name with specials is rendered as one quoted-string, which
    // `foldHeader` never splits: ` "name"` is a line of at least 3 octets
    // plus the name. Same reason as the filename guard in
    // `normalizeAttachment` — the escaping
    // in `formatAddress` costs heap per escaped character, and the line
    // check that would refuse it runs only after everything is rendered.
    // A non-ASCII name becomes encoded-words and folds; a plain name folds
    // at its spaces; neither is bounded here.
    if (
      ASCII_PRINTABLE.test(name) &&
      RFC5322_SPECIALS.test(name) &&
      name.length + QUOTED_NAME_LINE_OVERHEAD > MAX_LINE_OCTETS
    ) {
      throw new MimeError(
        fieldErrorCode(field),
        `${field}: display name is ${name.length} characters and must be quoted, which cannot be folded, ` +
          `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    // `@` in a display name almost always means a typo like
    // `a@x.dev<b@evil.dev>` got mis-parsed as `name=a@x.dev,
    // email=b@evil.dev`. Reject so the caller sees a clear validation
    // error rather than silently rerouting to a different address.
    if (name.includes('@')) {
      throw new MimeError(
        fieldErrorCode(field),
        `${field}: display name '${name}' must not contain '@' (likely a malformed address).`,
      );
    }
  }
}

/**
 * Undo the quoted-pairs in the content of a quoted display name: `\x` →
 * `x` for any `x` (RFC 5322 §3.2.4 — `qtext` excludes `"` and `\`, so a
 * quoted-string carries either only as a quoted-pair). The parsed name is
 * the RAW text `formatAddress` will quote and escape again, so leaving the
 * pairs in place would escape them twice. Only the quoted branch
 * of `parseAddress` calls this; a backslash in an unquoted name is a
 * character like any other, as it is in the object form.
 *
 * NOT `text.replace(/\\(.)/g, '$1')`: a global-regex replacement holds one
 * part per match before it builds the result, about 60 bytes each, and
 * nothing bounds this name before it runs — the quoted-string line guard
 * in `validateAddressParts` needs the DECODED name, and a non-ASCII name is
 * never bounded at all. Measured, 10 MiB of `\"` pairs peaked at 307 MB of
 * heap that way and terminated a 128 MB isolate; this shape peaks at 49 MB.
 * Same discipline as `to7bitBody`: one counting pass, a buffer of exactly
 * the output size, one fill, and one chunked `codeUnitsToString`.
 * The common case — no backslash at all — is one scan and no allocation.
 * The regex that admits the text guarantees every backslash is followed by
 * a character, so the fill never reads past the end.
 */
function unquotePairs(text: string): string {
  const first = text.indexOf('\\');
  if (first === -1) {
    return text;
  }
  let pairs = 0;
  for (let i = first; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x5c) {
      pairs++;
      i++;
    }
  }
  // UTF-16 code units, not bytes: a quoted name may be non-ASCII, and a
  // surrogate pair is two units that round-trip exactly.
  const out = new Uint16Array(text.length - pairs);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c === 0x5c) {
      c = text.charCodeAt(++i);
    }
    out[n++] = c;
  }
  return codeUnitsToString(out);
}

/**
 * Parse one address — a bare `email@domain` or `Display Name <email@domain>`
 * — into its parts, throwing a `MimeError` for `field` on anything else.
 * Exported so `void.config.ts` `email.from` is validated by the same rules
 * the runtime applies to `from` at send time.
 */
export function parseAddress(value: Address, field: string): { email: string; name?: string } {
  if (typeof value === 'string') {
    rejectCRLF(`${field} address`, value);
    // Match `Display Name <email@domain>` with paired quotes around the
    // name (both or neither).
    //
    // The unquoted name must start and end on a non-whitespace character so
    // `[^"<\s]` cannot take a space from the surrounding `\s*`. Letting
    // consecutive quantifiers compete for one whitespace run makes the
    // backtracker cubic in its length (4,000 leading spaces cost 10 s).
    const quoted = value.match(/^\s*"((?:[^"\\]|\\.)*)"\s*<\s*([^>\s]+)\s*>\s*$/);
    const angle =
      quoted ?? value.match(/^\s*(?:([^"<\s](?:[^"<]*[^"<\s])?)\s*)?<\s*([^>\s]+)\s*>\s*$/);
    if (angle) {
      // The quoted form's `\"` and `\\` are quoted-pairs, undone here so
      // the parsed name is the raw text — the same thing the object form
      // carries — and `formatAddress` escapes it exactly once. Decoded
      // BEFORE `validateAddressParts`, whose quoted-string line guard has
      // to see the name `formatAddress` will render.
      const name = (quoted ? unquotePairs(angle[1] ?? '') : angle[1])?.trim();
      const email = angle[2];
      validateAddressParts(field, email, name);
      return name ? { email, name } : { email };
    }
    const trimmed = value.trim();
    validateAddressParts(field, trimmed);
    return { email: trimmed };
  }
  validateAddressParts(field, value.email ?? '', value.name);
  return value.name ? { email: value.email, name: value.name } : { email: value.email };
}

function parseAddresses(
  value: Address | Array<Address>,
  field: string,
): Array<{ email: string; name?: string }> {
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => parseAddress(entry, field));
}

/** Entries in one recipient field, counted the way `parseAddresses` will see them. */
function countRecipients(value: Address | Array<Address> | undefined): number {
  if (!value) {
    return 0;
  }
  return Array.isArray(value) ? value.length : 1;
}

/**
 * Keeps the `exceeds Cloudflare limit of <N> bytes` tail that `buildMime`'s
 * own size error already uses, so the documented shape — and any caller
 * matching on it — holds for both paths.
 */
function attachmentsTooLargeError(bytes: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `email: attachment size ${bytes} bytes exceeds Cloudflare limit of ${MAX_ATTACHMENT_BYTES_TOTAL} bytes.`,
  );
}

/**
 * Size of `content` WITHOUT materializing it.
 *
 * A string reports its UTF-16 `length`, which is a sound LOWER bound on its
 * UTF-8 byte length — every code unit encodes to at least one byte — so this
 * can never reject a string that would have fit; the exact length is charged
 * after the encode. Anything else reports 0 and is left to `toBytes` to reject
 * by type.
 */
function declaredSize(content: Attachment['content']): number {
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }
  if (content instanceof ArrayBuffer) {
    return content.byteLength;
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return content.size;
  }
  if (typeof content === 'string') {
    return content.length;
  }
  return 0;
}

async function toBytes(content: Attachment['content']): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer());
  }
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  throw new MimeError(
    'MIME_ERROR',
    'attachment content must be string, Uint8Array, ArrayBuffer, or Blob.',
  );
}

async function normalizeAttachment(att: Attachment): Promise<NormalizedAttachment> {
  if (!att.filename) {
    throw new MimeError('MIME_ERROR', 'attachment: missing filename.');
  }
  rejectCRLF('attachment filename', att.filename);
  // A quoted parameter never folds — `foldHeader` keeps a quoted-string
  // whole — so ` filename="…"` is one line of at least 12 octets plus the
  // filename. Refuse here what the post-render line check would refuse
  // anyway: `quoteParam` costs heap per escaped character, and a filename
  // of ~1.7M quotes killed a 128 MB isolate before that check could run.
  // `length` never exceeds the UTF-8 octet count, so this cannot reject a
  // filename whose line would have fit.
  if (att.filename.length + QUOTED_FILENAME_LINE_OVERHEAD > MAX_LINE_OCTETS) {
    throw new MimeError(
      'MIME_ERROR',
      `attachment filename is ${att.filename.length} characters; a quoted \`filename=\` parameter cannot be folded, ` +
        `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten the filename.`,
    );
  }
  // After the bound: `rejectCRLF` above answers for the line delimiters on
  // the raw string, and this scan is over a filename already known to fit.
  rejectControls('attachment filename', att.filename);
  if (att.contentType !== undefined) {
    rejectCRLF('attachment contentType', att.contentType);
    // Same order as the filename: the bound, then the scans. `Content-Type:
    // <contentType>; name="…"` puts the media type on the line ahead of the
    // builder's own parameter, and `validateMediaType` keeps one string per
    // parameter, so both run over a value already known to fit.
    if (att.contentType.length + CONTENT_TYPE_LINE_OVERHEAD > MAX_LINE_OCTETS) {
      throw new MimeError(
        'MIME_ERROR',
        `attachment contentType is ${att.contentType.length} characters; at most ${MAX_LINE_OCTETS - CONTENT_TYPE_LINE_OVERHEAD} fit ` +
          `on the Content-Type line under the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    rejectControls('attachment contentType', att.contentType);
    validateMediaType('attachment contentType', att.contentType);
  }
  if (att.contentId !== undefined) {
    rejectCRLF('attachment contentId', att.contentId);
    // Same order again: the bound, then the scans. An id the grammar admits
    // has no whitespace, so `Content-ID: <id>` is one token after the field
    // name and `foldHeader` returns the line whole: exactly the field name
    // plus the id plus the `<` `>` `buildAttachmentPart` adds around a bare
    // one — an id that already starts with `<` renders as given, so it is
    // allowed those 2 characters more. `length` never exceeds the UTF-8
    // octet count, so this cannot reject an id whose line would have fit;
    // an over-long id with whitespace in it is refused here rather than
    // by the grammar, and refused either way.
    const brackets = att.contentId.startsWith('<') ? 0 : 2;
    if (att.contentId.length + brackets + CONTENT_ID_LINE_OVERHEAD > MAX_LINE_OCTETS) {
      throw new MimeError(
        'MIME_ERROR',
        `attachment contentId is ${att.contentId.length} characters; at most ${MAX_LINE_OCTETS - CONTENT_ID_LINE_OVERHEAD - brackets} fit ` +
          `on the Content-ID line under the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    rejectControls('attachment contentId', att.contentId);
    validateContentId('attachment contentId', att.contentId);
  }
  // The type admits only the two literals, but that binds nothing at
  // runtime: a JS caller, or a JSON-parsed options object, can hand over any
  // string, and `buildAttachmentPart` interpolates the value straight into
  // `Content-Disposition`. An allow-list, not `rejectCRLF`: there is no
  // third disposition this builder could render meaningfully.
  if (
    att.disposition !== undefined &&
    att.disposition !== 'attachment' &&
    att.disposition !== 'inline'
  ) {
    throw new MimeError('MIME_ERROR', "attachment disposition must be 'attachment' or 'inline'.");
  }
  const bytes = await toBytes(att.content);
  return {
    filename: att.filename,
    contentType: att.contentType ?? inferContentType(att.filename),
    bytes,
    contentId: att.contentId,
    disposition: att.disposition ?? (att.contentId ? 'inline' : 'attachment'),
  };
}

/**
 * Validate inputs and produce a normalized email shape that can be handed to
 * the MIME builder, the dev inbox, or the test harness without re-parsing.
 */
export async function normalizeEmail(opts: {
  from: Address;
  to: Address | Array<Address>;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Address;
  cc?: Address | Array<Address>;
  bcc?: Address | Array<Address>;
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
  threading?: { inReplyTo?: string; references?: string };
}): Promise<NormalizedEmail> {
  if (!opts.text && !opts.html) {
    throw new MimeError('MIME_ERROR', "email: at least one of 'text' or 'html' is required.");
  }
  if (opts.subject !== undefined) {
    rejectCRLF('subject', opts.subject);
  }
  if (opts.headers) {
    let headerInputBytes = 0;
    let headerBytes = 0;
    const encoder = new TextEncoder();
    for (const [name, value] of Object.entries(opts.headers)) {
      if (!HEADER_NAME.test(name)) {
        throw new MimeError(
          'MIME_ERROR',
          `headers: '${name}' is not a valid RFC 5322 header name.`,
        );
      }
      // A field name never folds. The shortest line that can carry it is
      // `Name:` on its own — what `foldHeader` emits when the value's
      // first token does not fit beside a long name — so a name over
      // `MAX_LINE_OCTETS - 1` characters has no legal rendering whatever
      // its value, and the post-render line check would refuse it. Refuse
      // it here instead, as `normalizeAttachment` does a filename: that
      // check runs only after the name has been lowercased, joined into
      // its line, the header block, `rawText` and `raw` — four copies of a
      // name that can be the whole message. `HEADER_NAME` admits only
      // ASCII, so `length` is the octet count exactly and this cannot
      // reject a name whose line would have fit.
      if (name.length + HEADER_NAME_LINE_OVERHEAD > MAX_LINE_OCTETS) {
        throw new MimeError(
          'MIME_ERROR',
          `headers: a header name is ${name.length} characters; a field name cannot be folded, ` +
            `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten the name.`,
        );
      }
      // Keep raw input work bounded even when folding later collapses a long
      // whitespace run. The character check rejects huge values before the
      // UTF-8 measurement allocates its byte copy.
      if (headerInputBytes + name.length + value.length + 4 > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      headerInputBytes += name.length + encoder.encode(value).byteLength + 4;
      if (headerInputBytes > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      rejectCRLF(`header '${name}'`, value);
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      // Reject an obviously oversized value before encoding it. This is a
      // lower bound because encoded words and folding only add bytes.
      if (
        headerBytes + name.length + CUSTOM_HEADER_FRAMING_OCTETS + minHeaderValueOctets(value) >
        MAX_CUSTOM_HEADER_BYTES
      ) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      // Match the proxy's wire-level accounting exactly: RFC 2047 expansion,
      // every folded continuation line, and the terminating CRLF. encodeWord
      // always returns ASCII, so the rendered string length is its byte size.
      headerBytes += foldHeader(name, encodeWord(value)).length + CRLF.length;
      if (headerBytes > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
    }
  }
  // Before any address is parsed: the count is what bounds the work below.
  const recipientCount =
    countRecipients(opts.to) + countRecipients(opts.cc) + countRecipients(opts.bcc);
  if (recipientCount > MAX_RECIPIENTS) {
    throw new MimeError(
      'INVALID_TO',
      `email: too many recipients (max ${MAX_RECIPIENTS}, got ${recipientCount}) across 'to', 'cc' and 'bcc'.`,
    );
  }
  const from = parseAddress(opts.from, 'from');
  const to = parseAddresses(opts.to, 'to');
  if (to.length === 0) {
    throw new MimeError('INVALID_TO', "email: 'to' must include at least one recipient.");
  }
  const cc = opts.cc ? parseAddresses(opts.cc, 'cc') : [];
  const bcc = opts.bcc ? parseAddresses(opts.bcc, 'bcc') : [];
  const replyTo = opts.replyTo ? parseAddress(opts.replyTo, 'replyTo') : undefined;
  // Before any entry is normalized: the count is what bounds the loop below
  // for a zero-byte attachment, which the byte total never sees. The type
  // admits only an array, but that binds nothing at runtime, and the count
  // is only a bound on the loop if the loop walks the array it was read
  // from — so anything else is refused, as `toBytes` refuses a content of
  // a type outside the contract.
  const attachmentList = opts.attachments ?? [];
  if (!Array.isArray(attachmentList)) {
    throw new MimeError('MIME_ERROR', 'email: attachments must be an array.');
  }
  if (attachmentList.length > MAX_ATTACHMENTS) {
    throw new MimeError(
      'MIME_ERROR',
      `email: too many attachments (max ${MAX_ATTACHMENTS}, got ${attachmentList.length}).`,
    );
  }
  // Sequential, not `Promise.all`: the running total has to be charged
  // BEFORE each copy, or the entire set is already resident by the time
  // anything looks at a size. Sequencing costs nothing measurable — every
  // conversion in `toBytes` is synchronous except `Blob.arrayBuffer`, which
  // is a memcpy of bytes the caller already holds, so there is no I/O here to
  // overlap.
  const attachments: Array<NormalizedAttachment> = [];
  let attachmentBytes = 0;
  for (const att of attachmentList) {
    const declared = declaredSize(att.content);
    if (attachmentBytes + declared > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw attachmentsTooLargeError(attachmentBytes + declared);
    }
    const normalized = await normalizeAttachment(att);
    // Charge the exact length too: a non-ASCII string undercounts itself
    // above, and `declaredSize` reports 0 for a type `toBytes` will reject.
    attachmentBytes += normalized.bytes.byteLength;
    if (attachmentBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw attachmentsTooLargeError(attachmentBytes);
    }
    attachments.push(normalized);
  }
  // Threading headers are passed through as-is — they come from the
  // trusted reply path (buildReplyMessage), not user input. We still
  // reject CR/LF inside them, same as any other header value.
  if (opts.threading?.inReplyTo) {
    rejectCRLF('threading.inReplyTo', opts.threading.inReplyTo);
  }
  if (opts.threading?.references) {
    rejectCRLF('threading.references', opts.threading.references);
  }

  return {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject: opts.subject ?? '',
    text: opts.text,
    html: opts.html,
    headers: opts.headers ? { ...opts.headers } : {},
    attachments,
    threading: opts.threading,
  };
}

/**
 * RFC 2047 §2 caps an encoded-word at 75 characters *including* the
 * `=?UTF-8?B?` prefix (10) and the `?=` suffix (2). That leaves 63
 * characters of base64, and base64 spends 4 characters per 3 input
 * bytes, so 45 source bytes is the largest payload that fits — 48 would
 * need 64.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 45;

/**
 * RFC 2047 encoded-word for non-ASCII text in headers (UTF-8, base64).
 *
 * Text longer than one word's payload becomes several encoded-words
 * separated by a space, which `foldHeader` turns into CRLF + SPACE
 * wherever a line would otherwise overrun (RFC 2047 §6.2: whitespace
 * between adjacent encoded-words is dropped on decode either way). This
 * keeps each word under §2's 75-character ceiling and a long subject or
 * display name under RFC 5322 §2.1.1's 998-octet line limit.
 */
function encodeWord(text: string): string {
  if (ASCII_PRINTABLE.test(text)) {
    return text;
  }
  const encoder = new TextEncoder();
  // A code point is at most 4 UTF-8 bytes, so the buffer never needs
  // more than the budget plus one character of overshoot.
  const pending = new Uint8Array(ENCODED_WORD_PAYLOAD_BYTES + 4);
  let length = 0;
  const words: Array<string> = [];
  const flush = () => {
    if (length > 0) {
      words.push(`=?UTF-8?B?${base64(pending.subarray(0, length))}?=`);
      length = 0;
    }
  };
  // `for..of` iterates code points, so a surrogate pair is never split
  // across two words — RFC 2047 §5 forbids splitting a multi-octet
  // character between adjacent encoded-words, and half a pair would
  // decode to U+FFFD. Each chunk is base64'd on its own for the same
  // reason: encoding once and slicing the output would cut characters
  // mid-sequence. Every character is measured and appended exactly once,
  // so a character wider than the whole budget (impossible in UTF-8)
  // lands alone in its own word instead of spinning.
  for (const char of text) {
    const bytes = encoder.encode(char);
    if (length > 0 && length + bytes.length > ENCODED_WORD_PAYLOAD_BYTES) {
      flush();
    }
    pending.set(bytes, length);
    length += bytes.length;
  }
  flush();
  return words.join(' ');
}

/**
 * RFC 5322 §3.2.3, verbatim:
 *
 *     specials = "(" / ")" / "<" / ">" / "[" / "]" / ":" / ";" / "@" /
 *                "\" / "," / "." / DQUOTE
 *
 * A display name is a §3.2.5 `phrase = 1*word`, `word = atom /
 * quoted-string`, and `atext` is everything printable EXCEPT these, so an
 * ASCII name containing any of them must be rendered as one quoted-string.
 * The class below lists the thirteen in the RFC's order so it can be checked
 * against the production by eye. `.` matters: an unquoted `Dr. Smith` is
 * `obs-phrase` (§4.1), which §4 says MUST NOT be generated.
 */
const RFC5322_SPECIALS = /[()<>[\]:;@\\,."]/;

function formatAddress(addr: { email: string; name?: string }): string {
  if (!addr.name) {
    return addr.email;
  }
  // Non-ASCII → RFC 2047 encoded-word.
  if (!ASCII_PRINTABLE.test(addr.name)) {
    return `${encodeWord(addr.name)} <${addr.email}>`;
  }
  // ASCII with any specials → quoted-string.
  if (RFC5322_SPECIALS.test(addr.name)) {
    return `"${quoteParam(addr.name)}" <${addr.email}>`;
  }
  // Plain atom / atom-with-spaces.
  return `${addr.name} <${addr.email}>`;
}

function formatAddressList(addrs: Array<{ email: string; name?: string }>): string {
  return addrs.map(formatAddress).join(', ');
}

/**
 * Soft-fold a long header line. Fold points, strongest first: address-list
 * separators (a `, ` outside any double-quoted string), then any remaining
 * unquoted whitespace inside a part. A naive `split(/, /)` would split
 * inside `"Smith, John"`, corrupting quoted display names, and folding only
 * between whole parts is not enough — one recipient carrying a long encoded
 * display name, or a `References:` run of message IDs, is a single part
 * that can blow past RFC 5322 §2.1.1's 998-octet hard limit on its own.
 *
 * RFC 2047 §2 limits any header line carrying an encoded-word to 76
 * characters; RFC 5322 §2.1.1 makes 78 a SHOULD and 998 a MUST. Folding at
 * 76 satisfies all three. A comma always stays on the line it terminates.
 * A token longer than the budget still gets its own line, which is the
 * best a WSP-only fold rule allows (§3.2.2 permits folding only at WSP).
 *
 * One pass, and the only thing kept per input character is the folded
 * output itself: each finished line is one flat string in `lines`. Any
 * per-token allocation (a slice array, token objects, `out +=`) costs about
 * 130 bytes of heap per token, so a legal 3 MB subject of one-letter words
 * would terminate a 128 MB isolate even though the message fits.
 */
function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) {
    return line;
  }
  const MAX_LINE = 76;
  const lines: Array<string> = [];
  // Pieces of the line being built, joined by the single space each fold
  // point becomes. The first line starts on `Name:`; a continuation starts
  // on the empty string so the join yields its leading space.
  let current: Array<string> = [`${name}:`];
  let lineLen = name.length + 1;
  let chunks = 0;
  const emit = (text: string, comma: boolean) => {
    chunks++;
    const piece = comma ? `${text},` : text;
    if (piece.length > 0 && lineLen + 1 + piece.length > MAX_LINE) {
      lines.push(current.join(' '));
      current = ['', piece];
      lineLen = 1 + piece.length;
    } else {
      current.push(piece);
      lineLen += 1 + piece.length;
    }
  };
  // A token is emitted only once the scanner knows whether it is the last
  // of its part, because that one carries the part's comma. An empty part
  // (`a, , b`) still owes its separator, so it emits an empty chunk rather
  // than losing a comma.
  let tokenStart = -1;
  let heldStart = -1;
  let heldEnd = -1;
  const endToken = (i: number) => {
    if (tokenStart < 0) {
      return;
    }
    if (heldStart >= 0) {
      emit(value.slice(heldStart, heldEnd), false);
    }
    heldStart = tokenStart;
    heldEnd = i;
    tokenStart = -1;
  };
  const endPart = (isLast: boolean) => {
    if (heldStart >= 0) {
      emit(value.slice(heldStart, heldEnd), !isLast);
      heldStart = -1;
    } else {
      emit('', !isLast);
    }
  };
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escape) {
      escape = false;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (ch === '\\' && inQuotes) {
      escape = true;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (!inQuotes && ch === ',' && value[i + 1] === ' ') {
      endToken(i);
      endPart(false);
      i++; // skip the space
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      endToken(i);
      continue;
    }
    if (tokenStart < 0) {
      tokenStart = i;
    }
  }
  endToken(value.length);
  endPart(true);
  // One unbreakable token — a single long Message-ID, say. There is
  // nowhere to fold, and `Name:\r\n <token>` would shorten nothing.
  if (chunks <= 1) {
    return line;
  }
  lines.push(current.join(' '));
  return lines.join(CRLF);
}

/** RFC 5322 §2.1.1: each line MUST be at most 998 octets, excluding CRLF. */
const MAX_LINE_OCTETS = 998;
/** ` filename="` + `"`: the shortest line a quoted filename parameter can fold onto. */
const QUOTED_FILENAME_LINE_OVERHEAD = 12;
/**
 * ` ` + `;`: the shortest line an attachment's media type can fold onto,
 * the whole value taken as one token. `foldHeader` would split a value
 * of several parameters at their spaces, so this bound is exact for the
 * one-token media type every attachment carries in practice and
 * conservative for a run of parameters that together pass the line
 * limit; that is accepted, because the alternative — find the fold points
 * first — is the scan this bound exists to run ahead of.
 */
const CONTENT_TYPE_LINE_OVERHEAD = 2;
/**
 * `Content-ID: `: the only line an attachment's Content-ID can sit on. The
 * value is one token — `<id>` — so `foldHeader` cannot fold it onto a
 * continuation line the way it can a media type, and the field name is
 * part of what the id must fit beside. Exact, not conservative: the `<`
 * and `>` the builder adds around a bare id are charged at the call.
 */
const CONTENT_ID_LINE_OVERHEAD = 'Content-ID: '.length;
/** ` "` + `"`: the shortest line a quoted display name can fold onto. */
const QUOTED_NAME_LINE_OVERHEAD = 3;
/** `:` alone: the shortest line a header name can sit on, its value folded onto the next. */
const HEADER_NAME_LINE_OVERHEAD = 1;

/**
 * First line of `text` that exceeds the octet limit, if any.
 *
 * Every line is scanned, not just the top header block: a multipart part's
 * own headers (`Content-Disposition: …; filename="…"`) live inside the body
 * and are just as unfoldable. Body content cannot trip this — text is
 * quoted-printable re-encoded above 990 octets and base64 is emitted at a
 * fixed width — so a hit is always a header.
 *
 * One pass over the string, counting UTF-8 octets per CRLF-delimited line,
 * with NO allocation: a `split(CRLF)` would hold one substring per line, and
 * a legal body of pasted logs is millions of lines. Only a CRLF pair ends a
 * line; a bare CR or LF is content.
 */
function findOverlongLine(text: string): { index: number; octets: number } | undefined {
  let index = 0;
  let octets = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      if (octets > MAX_LINE_OCTETS) {
        return { index, octets };
      }
      index++;
      octets = 0;
      i++;
    } else if (c < 0x80) {
      octets += 1;
    } else if (c < 0x800) {
      octets += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        octets += 4; // the pair is one code point
        i++;
      } else {
        octets += 3; // lone surrogate encodes as U+FFFD
      }
    } else {
      octets += 3;
    }
  }
  return octets > MAX_LINE_OCTETS ? { index, octets } : undefined;
}

/**
 * Escape a value for a quoted-string parameter (RFC 2045 §5.1 value, whose
 * quoted-string comes from RFC 5322 §3.2.4).
 *
 * `qtext` excludes both `\\` and `"`, so each may appear only as a
 * quoted-pair: a raw trailing backslash would escape the closing quote, and
 * a conformant parser drops every other raw backslash.
 *
 * Backslash first, then quote — the other order would double-escape.
 */
function quoteParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function base64(bytes: Uint8Array): string {
  return btoa(codeUnitsToString(bytes));
}

function base64Wrapped(bytes: Uint8Array): string {
  const encoded = base64(bytes);
  const lines: Array<string> = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

function quotedPrintable(text: string): string {
  // Encode as UTF-8 bytes then quote per RFC 2045.
  const bytes = new TextEncoder().encode(text);
  // Emit into a byte buffer, not a string: `out += chunk` per byte builds a
  // V8 cons-string tree whose nodes cost ~56 bytes per encoded byte and stay
  // live until the message is flattened. Measured, 1 MiB of non-ASCII text
  // held 57 MiB that way; a 1.9 MiB body killed a 128 MB isolate while its
  // 5.9 MiB message was under the limit. Every input byte yields at most 3
  // output bytes, a soft break (3) lands at most once per 73 content bytes,
  // and a lone LF becomes CRLF, so this buffer never grows.
  const out = new Uint8Array(Math.ceil(bytes.length * 3 * (76 / 73)) + 8);
  let n = 0;
  let lineLen = 0;
  const HEX = '0123456789ABCDEF';
  const put = (c: number) => {
    out[n++] = c;
  };
  const flush = (c0: number, c1?: number, c2?: number) => {
    const width = c2 !== undefined ? 3 : c1 !== undefined ? 2 : 1;
    if (lineLen + width > 75) {
      put(0x3d);
      put(0x0d);
      put(0x0a);
      lineLen = 0;
    }
    put(c0);
    if (c1 !== undefined) {
      put(c1);
    }
    if (c2 !== undefined) {
      put(c2);
    }
    lineLen += width;
  };
  const quote = (b: number) => flush(0x3d, HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 0xf));
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      put(0x0d);
      put(0x0a);
      lineLen = 0;
      continue;
    }
    if (b === 0x0d) {
      // CR alone or part of CRLF — emit CRLF on the LF side, skip standalone CR.
      if (bytes[i + 1] === 0x0a) {
        continue;
      }
      put(0x0d);
      put(0x0a);
      lineLen = 0;
      continue;
    }
    if (b === 0x20 || b === 0x09) {
      // Defer encoding decision: a space at end-of-line must be quoted.
      const isLast = i === bytes.length - 1 || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d;
      if (isLast) {
        quote(b);
      } else {
        flush(b);
      }
      continue;
    }
    if (b === 0x3d || b < 0x20 || b > 0x7e) {
      quote(b);
      continue;
    }
    flush(b);
  }
  return codeUnitsToString(out.subarray(0, n));
}

/** One character per code unit, in 32K chunks to stay under the call-argument limit. */
function codeUnitsToString(units: Uint8Array | Uint16Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < units.length; i += chunk) {
    s += String.fromCharCode(...units.subarray(i, i + chunk));
  }
  return s;
}

/**
 * Whether a body must be quoted-printable encoded: anything outside
 * printable ASCII, or any line longer than 990 characters (RFC 5322 §2.1.1
 * makes 998 octets the hard limit). Only LF and CRLF end a line; a bare CR
 * is a control character like any other and forces the encoding.
 *
 * One pass over the string with NO allocation: a `replace`/`split` shape
 * holds a copy of the body plus one substring per line, and a legal 6 MB
 * body of millions of two-character lines needed about 100 MB that way.
 */
function needsQuotedPrintable(text: string): boolean {
  let lineLen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      lineLen = 0;
      continue;
    }
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        continue;
      }
      return true;
    }
    if (c < 0x20 || c > 0x7e) {
      return true;
    }
    lineLen++;
    if (lineLen > 990) {
      return true;
    }
  }
  return false;
}

/**
 * The 7bit body: `text` with every bare LF widened to CRLF, and every CRLF
 * kept. Only called once `needsQuotedPrintable` has returned false, so every
 * character is printable ASCII, LF, or the CR of a CRLF — one byte each —
 * and a byte buffer is exact.
 *
 * NOT `text.replace(/\r?\n/g, CRLF)`: V8 builds a global-regex replacement
 * from a parts array that holds two or three slots per match, grown by
 * doubling, so that one line cost 144 MB of heap on a legal 6 MB body of
 * 3M lines and terminated a 128 MB isolate — the largest single allocation
 * in the whole build, for a body that renders to 9 MB. The buffer here is
 * the output size, known up front from one counting pass. A body that is
 * already CRLF-only (or has no line breaks) is returned as-is.
 */
function to7bitBody(text: string): string {
  let bare = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a && (i === 0 || text.charCodeAt(i - 1) !== 0x0d)) {
      bare++;
    }
  }
  if (bare === 0) {
    return text;
  }
  const out = new Uint8Array(text.length + bare);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a && (i === 0 || text.charCodeAt(i - 1) !== 0x0d)) {
      out[n++] = 0x0d;
    }
    out[n++] = c;
  }
  return codeUnitsToString(out);
}

/**
 * Lower bound on the octets `text` will occupy in the rendered message, in
 * one pass over the string and with NO allocation. Every UTF-8 byte yields at
 * least one octet on either body path — the 7bit path copies bytes and only
 * ever widens a bare LF to CRLF; the quoted-printable path emits each
 * non-ASCII byte as `=XX` (3 octets) and every other byte as itself, and its
 * soft breaks only add. So `ascii + 3 * nonAscii` can never overshoot the
 * real size, which keeps a false rejection impossible; `buildMime`'s final
 * check remains the authority. `TextEncoder.encode` would give the same count
 * but at the price of a full copy, which is exactly the allocation this
 * bound exists to avoid.
 */
function minBodyOctets(text: string): number {
  let octets = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      octets += 1;
    } else if (c < 0x800) {
      octets += 6; // 2 UTF-8 bytes, each `=XX`
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        octets += 12; // 4 UTF-8 bytes for the pair
        i++;
        continue;
      }
      octets += 9; // lone surrogate encodes as U+FFFD, 3 bytes
    } else {
      octets += 9; // 3 UTF-8 bytes
    }
  }
  return octets;
}

/** Octets a base64 body of `n` bytes occupies at 76 columns, excluding CRLF. */
function base64Octets(n: number): number {
  return Math.ceil(n / 3) * 4;
}

interface MimePart {
  headers: Array<[string, string]>;
  body: string;
}

function renderPart(part: MimePart): string {
  const lines = part.headers.map(([k, v]) => foldHeader(k, v));
  return lines.join(CRLF) + CRLF + CRLF + part.body;
}

function buildBodyPart(contentType: string, body: string): MimePart {
  const useQp = needsQuotedPrintable(body);
  return {
    headers: [
      ['Content-Type', `${contentType}; charset=UTF-8`],
      ['Content-Transfer-Encoding', useQp ? 'quoted-printable' : '7bit'],
    ],
    body: useQp ? quotedPrintable(body) : to7bitBody(body),
  };
}

function buildAttachmentPart(att: NormalizedAttachment): MimePart {
  const headers: Array<[string, string]> = [
    ['Content-Type', `${att.contentType}; name="${quoteParam(att.filename)}"`],
    ['Content-Transfer-Encoding', 'base64'],
    ['Content-Disposition', `${att.disposition}; filename="${quoteParam(att.filename)}"`],
  ];
  if (att.contentId) {
    const cid = att.contentId.startsWith('<') ? att.contentId : `<${att.contentId}>`;
    headers.push(['Content-ID', cid]);
  }
  return { headers, body: base64Wrapped(att.bytes) };
}

function makeBoundary(prefix: string): string {
  // 16 random bytes → 24-char base64. Workers + browsers expose crypto.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `=_void_${prefix}_${base64(bytes).replace(/[+/=]/g, '')}`;
}

function wrapMultipart(
  type: 'mixed' | 'alternative' | 'related',
  parts: Array<MimePart>,
): MimePart {
  const boundary = makeBoundary(type);
  const headerEntries: Array<[string, string]> = [
    ['Content-Type', `multipart/${type}; boundary="${boundary}"`],
  ];
  const body =
    parts.map((p) => `--${boundary}${CRLF}${renderPart(p)}`).join(CRLF) +
    `${CRLF}--${boundary}--${CRLF}`;
  return { headers: headerEntries, body };
}

const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
  'date',
  'message-id',
  // Threading headers are owned by replyEmail() — accepting them via
  // the user-supplied `headers` map would let a caller spoof reply
  // chains. replyEmail builds them itself from the original message.
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
]);

/**
 * Lower bound on the octets one header VALUE occupies once `encodeWord` (or
 * `formatAddress`, for a display name) and `foldHeader` have rendered it, in
 * one pass over the string and with NO allocation.
 *
 * `encodeWord` leaves a value alone when every character is printable ASCII
 * and otherwise B-encodes ALL of it, so the two paths need different terms:
 *
 * - Plain: every character is at least one octet, EXCEPT whitespace.
 *   `foldHeader` re-joins a long value from its non-WSP tokens, so a run of
 *   spaces or tabs collapses to one, and a bound that charged them could
 *   reject a message that fits. Only the non-WSP characters count.
 * - Encoded: each RFC 2047 word carries at most `ENCODED_WORD_PAYLOAD_BYTES`
 *   (45) UTF-8 bytes as base64 — `ceil(n / 3) * 4 >= 4n / 3` octets — inside
 *   12 octets of `=?UTF-8?B?` and `?=`, so there are at least `floor(n / 45)`
 *   words' worth of framing. Whitespace inside the value is base64 like any
 *   other byte; only the single separators between words fold.
 *
 * Folding (`foldHeader`) can only ADD octets beyond that — a `CRLF SP` per
 * line — and quoting a display name (`formatAddress`) adds the quotes and
 * escapes, so neither path can render fewer octets than this returns.
 * Measured, the encoded bound is 96% of the rendered size for CJK, where the
 * real cost is 5 octets per character; a UTF-16 `length` would have counted
 * 1 and let the isolate die on a header five times over the limit.
 */
function minHeaderValueOctets(value: string): number {
  let utf8 = 0;
  let visible = 0;
  let encoded = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) {
      utf8 += 1;
      if (c === 0x20 || c === 0x09) {
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        encoded = true;
      }
      visible += 1;
    } else {
      encoded = true;
      if (c < 0x800) {
        utf8 += 2;
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
        const d = value.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          utf8 += 4; // the pair is one code point
          i++;
          continue;
        }
        utf8 += 3; // lone surrogate encodes as U+FFFD
      } else {
        utf8 += 3;
      }
    }
  }
  if (!encoded) {
    return visible;
  }
  return Math.floor((utf8 * 4) / 3) + 12 * Math.floor(utf8 / ENCODED_WORD_PAYLOAD_BYTES);
}

/** Lower bound on one rendered address: its display name, plus the address itself verbatim. */
function minAddressOctets(addr: { email: string; name?: string }): number {
  return addr.email.length + (addr.name ? minHeaderValueOctets(addr.name) : 0);
}

/**
 * Lower bound on the octets of a value rendered VERBATIM — never through
 * `encodeWord` — into a header `foldHeader` may still fold: `In-Reply-To`,
 * `References`, and an attachment part's `Content-Type` media type and
 * `Content-ID`. Every non-WSP UTF-16 code unit is at least one octet of
 * UTF-8; a WSP run may collapse to a single space when the line folds, so
 * none is charged. The `<>` around a Content-ID and the fold's `CRLF SP`
 * only add.
 *
 * `minHeaderValueOctets` cannot stand in here: a non-ASCII value sends it
 * down the encoded-word formula (4.8 octets per CJK character) while these
 * values render as raw UTF-8 (3), so it would overshoot and could reject a
 * message that fits.
 */
function minVerbatimOctets(value: string): number {
  let octets = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) {
      octets += 1;
    }
  }
  return octets;
}

/**
 * Octets every attachment part costs before any of its values: what
 * `wrapMultipart`, `renderPart` and `buildAttachmentPart` emit for a part
 * whose filename, media type, disposition and content are all empty. Each
 * term is emitted verbatim on every path — `foldHeader` returns a short
 * line as-is and re-joins a long one from its tokens with at least one
 * space between them, so the space after `Name:` and the one after `;` are
 * floors, not counts — and a fold's `CRLF SP` only adds. The boundary's
 * random suffix is left out: `makeBoundary` strips `+`, `/` and `=`, so it
 * has no provable minimum, and `mixed` is the shortest prefix an attachment
 * part can sit under.
 */
const ATTACHMENT_PART_MIN_OCTETS: number =
  CRLF.length + // the join between this part and the one before it
  ('--=_void_mixed_'.length + CRLF.length) +
  ('Content-Type: '.length + '; name=""'.length + CRLF.length) +
  ('Content-Transfer-Encoding: base64'.length + CRLF.length) +
  ('Content-Disposition: '.length + '; filename=""'.length + CRLF.length) +
  CRLF.length; // the blank line before the body

/**
 * Cap on the attachment COUNT, checked against the raw list in
 * `normalizeEmail` before a single entry is normalized.
 *
 * Every part costs at least `ATTACHMENT_PART_MIN_OCTETS` of framing plus
 * its filename twice, and `normalizeAttachment` refuses an empty filename,
 * so the size projection in `buildMime` charges a part at least 119 octets
 * and refuses one more part than this whatever else the message holds.
 * That projection runs only after `normalizeEmail` has normalized EVERY
 * entry, and `MAX_ATTACHMENT_BYTES_TOTAL` cannot bound that loop for a
 * zero-byte attachment — its running total never advances — while the
 * normalized copy (the object, a fresh `Uint8Array`, the `TextEncoder`
 * that made it) costs about 275 bytes of live heap per entry. Measured, 2M
 * empty attachments terminated a 128 MB isolate in 0.3 s instead of
 * returning `MIME_ERROR`; this many normalize in 24 MB and are then refused
 * by the post-render size check under the same ceiling.
 *
 * Derived, not chosen: it is exactly the largest count the projection can
 * admit, so this cannot reject a message that would have been accepted, and
 * `buildMime` remains the authority on the final size. Same class as
 * `MAX_ATTACHMENT_BYTES_TOTAL` — a developer-experience guardrail on the
 * app's own input, not the security boundary.
 */
export const MAX_ATTACHMENTS: number = Math.floor(
  MAX_MESSAGE_BYTES / (ATTACHMENT_PART_MIN_OCTETS + 2),
);

/**
 * Octets every custom header costs around its value: the `: ` after the
 * name and the CRLF that ends its line. Exact, not a floor, once the name
 * is counted: `buildMime` renders each non-reserved custom header through
 * `foldHeader`, which emits the name verbatim, then `: ` — or, when the
 * value's first token does not fit beside the name, `:` CRLF SP, which is
 * more — and `join(CRLF)` ends every header line, a custom header never
 * being the last of the block (the body part's own headers follow it).
 */
const CUSTOM_HEADER_FRAMING_OCTETS: number = ': '.length + CRLF.length;

/**
 * Lower bound on the octets of every header `buildMime` renders from
 * caller-supplied values: `Subject`, the custom headers, the addresses in
 * `From`, `To`, `Cc` and `Reply-To`, the `In-Reply-To` / `References` pair
 * `replyEmail` threads through (remote-sender controlled, up to the whole
 * inbound message), and each attachment part's `Content-Type`, `Content-ID`
 * and — twice, once per header it is rendered into — filename. `Bcc` is
 * never rendered and a reserved custom header is dropped, so neither is
 * counted — charging either could reject a message that fits. The fixed
 * `Name: ` and `CRLF` of the headers `buildMime` itself names — `Subject`,
 * the address lists, the threading pair — are omitted for the same reason
 * a lower bound may omit any term. They are NOT omitted where the caller
 * controls the name or the count, because there they can be the whole
 * message:
 *
 * - A custom header's name is rendered verbatim, and `normalizeEmail`
 *   bounds ONE name at under a kilobyte, not the sum, nor the count. With
 *   empty values the names and the `: ` CRLF around each are the entire
 *   size, and the framing is exact once the name is counted (see
 *   `CUSTOM_HEADER_FRAMING_OCTETS`), so charging both cannot reject a
 *   message that fits. Uncharged, 60k empty headers with 500-character
 *   names (a 30 MB message) would project to zero.
 * - An attachment part: `normalizeAttachment` bounds ONE filename at under
 *   a kilobyte, not the sum, and a message is free to carry any number of
 *   parts, so the filename and the framing every part is wrapped in are
 *   the whole size of a message of empty attachments. Measured, 50k
 *   zero-byte attachments with legal 986-character filenames rendered to
 *   106 MB — held three to four times over between the parts, their join,
 *   `rawText` and `raw` — and terminated a 128 MB isolate before the final
 *   size check could return `MIME_ERROR`.
 *
 * The header COUNT is deliberately not bounded here. Each header costs
 * at least five octets (a one-character name, `: `, CRLF), so the count
 * the projection can admit is finite, and past a few hundred thousand keys
 * the caller's own object — measured at about 74 bytes per key, before
 * `sendEmail` is called — is the dominant cost, which no check inside this
 * module can pre-empt. Rendering does add live heap per header (about
 * 150 bytes: two `Object.entries`, the `topHeaders` pair, the folded line),
 * so a legal message of 500k four-character headers still does not fit a
 * 128 MB isolate while one of 400k does; a bound on that would be the
 * framework's own number — the platform proxy bounds bytes, not headers —
 * and is left as a product decision rather than invented here.
 */
function minHeaderOctets(email: NormalizedEmail): number {
  let octets = minHeaderValueOctets(email.subject);
  for (const [name, value] of Object.entries(email.headers)) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) {
      // `HEADER_NAME` admits only ASCII, so `length` is the name's octets.
      octets += name.length + CUSTOM_HEADER_FRAMING_OCTETS + minHeaderValueOctets(value);
    }
  }
  octets += minAddressOctets(email.from);
  for (const addr of email.to) {
    octets += minAddressOctets(addr);
  }
  for (const addr of email.cc) {
    octets += minAddressOctets(addr);
  }
  if (email.replyTo) {
    octets += minAddressOctets(email.replyTo);
  }
  if (email.threading?.inReplyTo) {
    octets += minVerbatimOctets(email.threading.inReplyTo);
  }
  if (email.threading?.references) {
    octets += minVerbatimOctets(email.threading.references);
  }
  for (const att of email.attachments) {
    // The filename sits inside a quoted-string in both `name="…"` and
    // `filename="…"`, and `foldHeader` never splits a quoted-string, so
    // every code unit of it — whitespace included — is at least one octet
    // on each line; `quoteParam`'s escapes only add.
    octets += ATTACHMENT_PART_MIN_OCTETS + 2 * att.filename.length;
    octets += minVerbatimOctets(att.contentType);
    if (att.contentId) {
      octets += minVerbatimOctets(att.contentId);
    }
  }
  return octets;
}

function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'localhost';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = base64(bytes).replace(/[+/=]/g, '');
  return `<${id}@${domain}>`;
}

/**
 * Build the raw RFC 5322 message body. Returns the message bytes plus the
 * generated Message-ID header so callers can surface it in the result.
 */
export function buildMime(email: NormalizedEmail): { raw: Uint8Array; messageId: string } {
  // Project the message size BEFORE rendering anything — headers included.
  // The final check below sees the message only after every header has been
  // encoded and folded and every body quoted-printable encoded, all of it
  // rendered into `rawText` and encoded again. Measured, that peak is about
  // 11x the UTF-8 bytes of a non-ASCII body, and `encodeWord` alone holds
  // over 3x the UTF-8 bytes of a non-ASCII header (its array of encoded
  // words plus their join) before the fold, the join, `rawText` and `raw`
  // each add another copy of the rendered header. A body several times over the
  // limit, or a 20 MB subject or display name, terminated a 128 MB isolate
  // instead of returning the `MIME_ERROR` the guide promises. Each term is
  // a lower bound on the rendered size, so this never rejects a message
  // that would have fit; the final check stays the authority.
  const projected =
    minHeaderOctets(email) +
    (email.text ? minBodyOctets(email.text) : 0) +
    (email.html ? minBodyOctets(email.html) : 0) +
    email.attachments.reduce((sum, a) => sum + base64Octets(a.bytes.byteLength), 0);
  if (projected > MAX_MESSAGE_BYTES) {
    throw new MimeError(
      'MIME_ERROR',
      `email: message is at least ${projected} bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }

  const messageId = generateMessageId(email.from.email);
  const date = new Date().toUTCString().replace('GMT', '+0000');

  const topHeaders: Array<[string, string]> = [
    ['Date', date],
    ['From', formatAddress(email.from)],
    ['To', formatAddressList(email.to)],
  ];
  if (email.cc.length > 0) {
    topHeaders.push(['Cc', formatAddressList(email.cc)]);
  }
  // Bcc is intentionally omitted from the rendered headers. The CF `send_email`
  // binding fans out one envelope per recipient, but every envelope carries
  // the same raw MIME body — so a `Bcc:` header here would expose the BCC list
  // to every To/Cc recipient. The envelope itself handles BCC delivery.
  if (email.replyTo) {
    topHeaders.push(['Reply-To', formatAddress(email.replyTo)]);
  }
  topHeaders.push(['Subject', encodeWord(email.subject)]);
  topHeaders.push(['Message-ID', messageId]);
  // Threading headers from the trusted reply path. These are reserved
  // against user-supplied `headers` (RESERVED_HEADERS) so the only way
  // they land in the wire MIME is via `email.threading`.
  if (email.threading?.inReplyTo) {
    topHeaders.push(['In-Reply-To', email.threading.inReplyTo]);
  }
  if (email.threading?.references) {
    topHeaders.push(['References', email.threading.references]);
  }
  topHeaders.push(['MIME-Version', '1.0']);

  for (const [name, value] of Object.entries(email.headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    topHeaders.push([name, encodeWord(value)]);
  }

  const textPart = email.text ? buildBodyPart('text/plain', email.text) : undefined;
  const htmlPart = email.html ? buildBodyPart('text/html', email.html) : undefined;

  let bodyPart: MimePart;
  if (textPart && htmlPart) {
    bodyPart = wrapMultipart('alternative', [textPart, htmlPart]);
  } else {
    bodyPart = (textPart ?? htmlPart) as MimePart;
  }

  if (email.attachments.length > 0) {
    const inlineAttachments = email.attachments.filter((a) => a.disposition === 'inline');
    const fileAttachments = email.attachments.filter((a) => a.disposition !== 'inline');

    if (inlineAttachments.length > 0 && htmlPart) {
      // Wrap (alternative or html) with inline attachments via multipart/related.
      bodyPart = wrapMultipart('related', [
        bodyPart,
        ...inlineAttachments.map(buildAttachmentPart),
      ]);
    } else {
      // No inline images — treat all as regular file attachments.
      fileAttachments.push(...inlineAttachments);
    }
    if (fileAttachments.length > 0) {
      bodyPart = wrapMultipart('mixed', [bodyPart, ...fileAttachments.map(buildAttachmentPart)]);
    }
  }

  // Promote the body part's headers into the top-level headers.
  for (const [k, v] of bodyPart.headers) {
    topHeaders.push([k, v]);
  }

  const headerBlock = topHeaders.map(([k, v]) => foldHeader(k, v)).join(CRLF);
  const rawText = headerBlock + CRLF + CRLF + bodyPart.body;
  const raw = new TextEncoder().encode(rawText);

  // RFC 5322 §2.1.1 makes 998 octets per line a MUST, and RFC 5321
  // §4.5.3.1.6 caps an SMTP text line at 1000 including CRLF. `foldHeader`
  // can only fold at whitespace (§3.2.2), so a long token with none —
  // a JWT, a signed URL, a machine-generated Message-ID — cannot be folded
  // at all and leaks through both its single-chunk early return AND its
  // fold loop, which still gives an over-long chunk its own line.
  //
  // Checked here, after rendering, rather than per field: this is the only
  // place that sees every header path at once, including the header NAME
  // and the `filename=` / `name=` / `Content-ID` parameters that are built
  // outside `foldHeader`. Encoding the value instead of rejecting is not a
  // general remedy — RFC 2047 §5 permits encoded-words only in unstructured
  // fields, comments and phrases, so it is illegal in `References`,
  // `In-Reply-To`, `Content-ID` and parameter values, where a receiver
  // would read `=?UTF-8?B?…?=` as a literal id or filename. Truncating
  // silently corrupts: a clipped `References` breaks threading with no
  // signal, a clipped `Content-ID` orphans a `cid:` reference.
  const overlong = findOverlongLine(rawText);
  if (overlong !== undefined) {
    throw new MimeError(
      'MIME_ERROR',
      `email: header line ${overlong.index + 1} is ${overlong.octets} octets, over the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. ` +
        'A value with no whitespace cannot be folded — shorten it, or move it into the body.',
    );
  }

  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    throw new MimeError(
      'MIME_ERROR',
      `email: message size ${raw.byteLength} bytes exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }

  return { raw, messageId };
}
