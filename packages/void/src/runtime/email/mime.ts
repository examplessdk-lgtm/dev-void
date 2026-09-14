/**
 * Minimal RFC 5322 / 2047 / 2045 MIME builder for the void/email runtime.
 *
 * Scope is intentionally narrow — text/plain, text/html, multipart/alternative,
 * and multipart/mixed for attachments — covering >95% of transactional sends.
 * Inline images use multipart/related when both attachments and html are present.
 */

import type { Address, Attachment, NormalizedAttachment, NormalizedEmail } from './types.ts';

/** Cloudflare Email Workers reject messages larger than ~10 MB after base64 expansion. */
export const MAX_MESSAGE_BYTES: number = 10 * 1024 * 1024;

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
 * Cap on the recipient count across `to`, `cc` and `bcc`, checked against
 * the RAW input before a single address is parsed.
 *
 * The platform proxy refuses more than 100 recipients (`MAX_RECIPIENTS` in
 * `proxy/src/email.ts`, counted on the deduplicated list this module
 * produces), so on the platform a larger list is always rejected — but only
 * after the tenant has parsed every address and rendered the whole `To:`
 * header. Measured, that rendering costs about 250 bytes of heap per
 * recipient plus the header's own ~31 bytes per character, so 230k short,
 * valid addresses (a 4.8 MiB message, legal under `MAX_MESSAGE_BYTES`)
 * terminated a 128 MB isolate instead of reaching the proxy's `INVALID_TO`.
 * Under `void dev` the same list was captured as a success and failed only
 * once deployed. Mirroring the cap here makes it a precise, catchable error
 * at the call that went wrong, in every mode.
 *
 * This is the framework's own limit on an own-account deploy, where the
 * `SEND_EMAIL` binding sends one envelope per recipient and imposes no
 * per-call count. Cloudflare's object-form `send()` API caps `to + cc + bcc`
 * at 50, so 100 is the looser of the two.
 *
 * Counted on the raw entries rather than after deduplication: parsing is what
 * this bound exists to skip, so a list of 150 entries with 100 unique
 * addresses is refused here where the proxy would have accepted it.
 */
export const MAX_RECIPIENTS: number = 100;

/**
 * Cap on one parsed address. RFC 5321 §4.5.3.1 allows a 64-octet local part
 * and a 255-octet domain, so nothing over 320 characters can be delivered;
 * the platform proxy applies the same `MAX_RECIPIENT_LENGTH` to the same
 * parsed address. A display name is not bounded — it is folded or encoded
 * into legal header lines at any length, and the tokenizers below keep that
 * cost linear.
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

function validateAddressParts(field: string, email: string, name?: string): void {
  rejectCRLF(`${field} address`, email);
  if (email.length > MAX_ADDRESS_LENGTH) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: address is ${email.length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit.`,
    );
  }
  // Address must be a single token with EXACTLY ONE '@', a non-empty local
  // part and a non-empty domain, and no whitespace, quoting, or
  // list-separators. Without the separator rule, a `to: "a@x,b@y"` would
  // slip through the bare-string path and split into two recipients in the
  // rendered headers; without the exactly-one/non-empty rule, `user@`,
  // `@example.com` and `a@b@c` passed the preflight and were reported as a
  // successful capture in the dev inbox, only to fail once they reached the
  // platform — and as a different error code than the one advertised here.
  //
  // Deliberately NOT the platform's `isValidEmail`, which also requires a
  // dot in the domain: `user@localhost` and `x@y` are legal RFC 5321 and
  // are accepted today. Quoted local parts (`"a@b"@example.com`) stay
  // rejected by the `"` in the specials class below, as they already were.
  const at = email.indexOf('@');
  const singleAt = at > 0 && at === email.lastIndexOf('@') && at < email.length - 1;
  if (!singleAt || /\s/.test(email) || /[,;<>"()[\]\\]/.test(email)) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: '${email}' is not a valid email address.`,
    );
  }
  if (name !== undefined) {
    rejectCRLF(`${field} display name`, name);
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
 * Parse one address — a bare `email@domain` or `Display Name <email@domain>`
 * — into its parts, throwing a `MimeError` for `field` on anything else.
 * Exported so `void.json` `email.from` is validated by the same rules the
 * runtime applies to `from` at send time.
 */
export function parseAddress(value: Address, field: string): { email: string; name?: string } {
  if (typeof value === 'string') {
    rejectCRLF(`${field} address`, value);
    // Match `Display Name <email@domain>` with paired quotes around the
    // name (both or neither). The earlier regex had two independent
    // optional quotes, so a single stray `"` slipped through.
    //
    // The unquoted name must start and end on a non-whitespace character.
    // The earlier `^\s*([^"<]+?)?\s*<` let three consecutive quantifiers
    // compete for the same run of whitespace, which the backtracker
    // resolves by trying every split — cubic in the run length. Measured:
    // 4,000 leading spaces before a valid address (accepted, then trimmed)
    // cost 10 s; a 16 KB run would exceed the 30 s CPU limit. Both forms
    // accept the same strings with the same captures (checked exhaustively
    // to length 7 over `a`, space, tab, `<`, `>`, `"`, `@`, `\`, `,`);
    // this one is linear because `[^"<\s]` cannot take a space from `\s*`.
    const angle =
      value.match(/^\s*"((?:[^"\\]|\\.)*)"\s*<\s*([^>\s]+)\s*>\s*$/) ??
      value.match(/^\s*(?:([^"<\s](?:[^"<]*[^"<\s])?)\s*)?<\s*([^>\s]+)\s*>\s*$/);
    if (angle) {
      const name = angle[1]?.trim();
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
  if (att.contentType !== undefined) {
    rejectCRLF('attachment contentType', att.contentType);
  }
  if (att.contentId !== undefined) {
    rejectCRLF('attachment contentId', att.contentId);
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
    for (const [name, value] of Object.entries(opts.headers)) {
      if (!HEADER_NAME.test(name)) {
        throw new MimeError(
          'MIME_ERROR',
          `headers: '${name}' is not a valid RFC 5322 header name.`,
        );
      }
      rejectCRLF(`header '${name}'`, value);
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
  // Sequential, not `Promise.all`: the running total has to be charged
  // BEFORE each copy, or the entire set is already resident by the time
  // anything looks at a size. Sequencing costs nothing measurable — every
  // conversion in `toBytes` is synchronous except `Blob.arrayBuffer`, which
  // is a memcpy of bytes the caller already holds, so there is no I/O here to
  // overlap.
  const attachments: Array<NormalizedAttachment> = [];
  let attachmentBytes = 0;
  for (const att of opts.attachments ?? []) {
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
 * between adjacent encoded-words is dropped on decode either way). A
 * single unbounded word breached both §2's 75-character ceiling and —
 * for a long subject or display name — RFC 5322 §2.1.1's 998-octet hard
 * line limit, which nothing downstream repairs.
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

// RFC 5322 specials — names containing any of these MUST be quoted as a
// phrase. The earlier code path put this check inside the ATOM_SAFE
// branch, but ATOM_SAFE already excluded these specials, so the check was
// unreachable for `,` `(` `)` `<` `>` etc. — the fall-through hit
// encodeWord which short-circuits on ASCII and emitted unquoted, letting
// a comma in a display name split the address list.
const RFC5322_SPECIALS = /[",()<>:;@[\]\\]/;

function formatAddress(addr: { email: string; name?: string }): string {
  if (!addr.name) {
    return addr.email;
  }
  // Non-ASCII → RFC 2047 encoded-word.
  if (!ASCII_PRINTABLE.test(addr.name)) {
    return `${encodeWord(addr.name)} <${addr.email}>`;
  }
  // ASCII with any specials → quoted-string. Escape backslashes first so
  // the subsequent quote-escape doesn't double-escape them.
  if (RFC5322_SPECIALS.test(addr.name)) {
    const escaped = addr.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}" <${addr.email}>`;
  }
  // Plain atom / atom-with-spaces.
  return `${addr.name} <${addr.email}>`;
}

function formatAddressList(addrs: Array<{ email: string; name?: string }>): string {
  return addrs.map(formatAddress).join(', ');
}

/**
 * Soft-fold long header lines at address-list boundaries (`, `) outside
 * any double-quoted string. A naive `split(/, /)` would split inside
 * `"Smith, John"`, corrupting quoted display names.
 *
 * Both tokenizers here slice the input at the boundaries they find rather
 * than growing each piece with `current += ch`. V8 keeps that growth as a
 * cons-string tree of about 32 bytes per character, live until the piece is
 * next flattened — measured, a 4 MB header value held 128 MB across the two
 * passes, so one 800k-character non-ASCII display name (a legal 4 MiB
 * message) terminated a 128 MB isolate before `buildMime` could size it.
 */
function splitAddressList(value: string): Array<string> {
  const parts: Array<string> = [];
  let start = 0;
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === ',' && value[i + 1] === ' ') {
      parts.push(value.slice(start, i));
      i++; // skip the space
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * Split one address-list part at whitespace runs outside any
 * double-quoted string. RFC 5322 §3.2.2 permits folding only at WSP,
 * and keeping quoted strings whole means a fold never lands inside a
 * display name like `"Smith, John"`.
 */
function splitFoldPoints(part: string): Array<string> {
  const tokens: Array<string> = [];
  let start = 0;
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inQuotes) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (i > start) {
        tokens.push(part.slice(start, i));
      }
      start = i + 1;
    }
  }
  if (part.length > start) {
    tokens.push(part.slice(start));
  }
  return tokens;
}

function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) {
    return line;
  }
  // Fold points, strongest first: address-list separators (a `, `
  // outside any quoted string), then any remaining unquoted whitespace
  // inside a part. Folding only between whole parts is not enough — one
  // recipient carrying a long encoded display name, or a `References:`
  // run of message IDs, is a single part that can blow past RFC 5322
  // §2.1.1's 998-octet hard limit on its own.
  const chunks: Array<{ text: string; comma: boolean }> = [];
  const parts = splitAddressList(value);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const tokens = splitFoldPoints(parts[i]);
    if (tokens.length === 0) {
      // An empty part (`a, , b`) still owes its separator; without a
      // placeholder chunk the rendered value would lose a comma.
      chunks.push({ text: '', comma: !isLast });
      continue;
    }
    for (let j = 0; j < tokens.length; j++) {
      chunks.push({ text: tokens[j], comma: !isLast && j === tokens.length - 1 });
    }
  }
  // One unbreakable token — a single long Message-ID, say. RFC 5322
  // §3.2.2 only allows folding at WSP, so there is nowhere to fold and
  // `Name:\r\n <token>` would shorten nothing.
  if (chunks.length <= 1) {
    return line;
  }
  // RFC 2047 §2 limits any header line carrying an encoded-word to 76
  // characters; RFC 5322 §2.1.1 makes 78 a SHOULD and 998 a MUST.
  // Folding at 76 satisfies all three. A comma always stays on the line
  // it terminates. A chunk longer than the budget still gets its own
  // line, which is the best a WSP-only fold rule allows.
  const MAX_LINE = 76;
  let out = `${name}:`;
  let lineLen = out.length;
  for (const chunk of chunks) {
    const piece = chunk.comma ? `${chunk.text},` : chunk.text;
    if (piece.length > 0 && lineLen + 1 + piece.length > MAX_LINE) {
      out += `${CRLF} ${piece}`;
      lineLen = 1 + piece.length;
    } else {
      out += ` ${piece}`;
      lineLen += 1 + piece.length;
    }
  }
  return out;
}

/** RFC 5322 §2.1.1: each line MUST be at most 998 octets, excluding CRLF. */
const MAX_LINE_OCTETS = 998;

/**
 * First line of `text` that exceeds the octet limit, if any.
 *
 * Every line is scanned, not just the top header block: a multipart part's
 * own headers (`Content-Disposition: …; filename="…"`) live inside the body
 * and are just as unfoldable. Body content cannot trip this — text is
 * quoted-printable re-encoded above 990 octets and base64 is emitted at a
 * fixed width — so a hit is always a header.
 */
function findOverlongLine(text: string): { index: number; octets: number } | undefined {
  const lines = text.split(CRLF);
  const encoder = new TextEncoder();
  for (let i = 0; i < lines.length; i++) {
    const octets = encoder.encode(lines[i]).length;
    if (octets > MAX_LINE_OCTETS) {
      return { index: i, octets };
    }
  }
  return undefined;
}

/**
 * Escape a value for a quoted-string parameter (RFC 2045 §5.1 value, whose
 * quoted-string comes from RFC 5322 §3.2.4).
 *
 * `qtext` excludes both `\\` and `"`, so each may appear only as a
 * quoted-pair. Deleting the quotes and leaving backslashes raw — what this
 * did before — is wrong in two ways: a TRAILING backslash escapes the
 * closing quote and leaves the parameter unterminated, and every embedded
 * backslash is silently eaten by a conformant parser, so a Windows path
 * `C:\\Users\\bob\\report.pdf` arrived as `C:Usersbobreport.pdf`. Measured,
 * Python's `email.policy.default` and postal-mime both report
 * `InvalidHeaderDefect: end of header inside quoted string` on the first
 * case and disagree with a naive parser on the second.
 *
 * Backslash first, then quote — the other order would double-escape.
 *
 * Note this file's own `splitAddressList` and `splitFoldPoints` already
 * track quoted-pairs when folding, so the emitter was contradicting the
 * folder.
 */
function quoteParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function base64(bytes: Uint8Array): string {
  // workerd, browsers, and Node 18+ all expose btoa + binary string conversion.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
  return bytesToAsciiString(out.subarray(0, n));
}

/** Pure-ASCII bytes to a string, in the same 32K chunks `base64` uses. */
function bytesToAsciiString(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

function needsQuotedPrintable(text: string): boolean {
  // Encode any non-ASCII or any line longer than 998 bytes (RFC 5322 limit).
  if (!ASCII_PRINTABLE.test(text.replace(/\r?\n/g, ''))) {
    return true;
  }
  return text.split(/\r?\n/).some((line) => line.length > 990);
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
    body: useQp ? quotedPrintable(body) : body.replace(/\r?\n/g, CRLF),
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
  extra: Record<string, string> = {},
): MimePart {
  const boundary = makeBoundary(type);
  const headerEntries: Array<[string, string]> = [
    ['Content-Type', `multipart/${type}; boundary="${boundary}"`],
  ];
  for (const [k, v] of Object.entries(extra)) {
    headerEntries.push([k, v]);
  }
  const body =
    parts.map((p) => `--${boundary}${CRLF}${renderPart(p)}`).join(CRLF) +
    `${CRLF}--${boundary}--${CRLF}`;
  return { headers: headerEntries, body };
}

const RESERVED_HEADERS = new Set(
  [
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
  ].map((h) => h.toLowerCase()),
);

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

  // Project the body size BEFORE encoding anything. The final check below
  // sees the message only after every body has been quoted-printable
  // encoded, rendered into its part, concatenated into `rawText` and
  // encoded again — measured, that peak is about 11x the UTF-8 bytes of a
  // non-ASCII body, so a body several times over the limit terminates a
  // 128 MB isolate instead of returning the `MIME_ERROR` the guide promises.
  // Each term is a lower bound on the rendered size, so this never rejects
  // a message that would have fit; the final check stays the authority.
  const projected =
    (email.text ? minBodyOctets(email.text) : 0) +
    (email.html ? minBodyOctets(email.html) : 0) +
    email.attachments.reduce((sum, a) => sum + base64Octets(a.bytes.byteLength), 0);
  if (projected > MAX_MESSAGE_BYTES) {
    throw new MimeError(
      'MIME_ERROR',
      `email: message body is at least ${projected} bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
    );
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
