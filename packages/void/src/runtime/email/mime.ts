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

/**
 * Cap on the local part (before the `@`) of one parsed address, in UTF-8
 * OCTETS. RFC 5321 §4.5.3.1.1 sets 64 as the longest every receiver MUST
 * accept; a client MAY send a longer one but MUST expect the server to
 * reject it, so it is not deliverable in general. The platform proxy does
 * not check it — its `MAX_RECIPIENT_LENGTH` is the 320 total above — so a
 * 65-octet local part used to pass this preflight, be captured as a success
 * under `void dev` and by the test harness, and be turned away only by an
 * MTA. Counted in octets because the address rules below admit a non-ASCII
 * local part (SMTPUTF8, RFC 6531, which keeps RFC 5321's limits as octet
 * counts): 22 CJK characters are 66 octets. The same figure caps the
 * default `<slug>+noreply@` sender — `VALID_SLUG` in `runtime/email.ts`
 * and `MAX_SLUG_LENGTH` (`64 - 8`) in `cli/project-slug.ts` and the API —
 * which already refused it while an explicit `from` of the same address
 * was accepted.
 */
export const MAX_LOCAL_PART_OCTETS: number = 64;

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
  // After the total-length bound above, so the encode is over at most
  // `MAX_ADDRESS_LENGTH` characters; see `MAX_LOCAL_PART_OCTETS`.
  const localOctets = new TextEncoder().encode(email.slice(0, at)).length;
  if (localOctets > MAX_LOCAL_PART_OCTETS) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: local part is ${localOctets} octets, over the ${MAX_LOCAL_PART_OCTETS}-octet limit in RFC 5321 §4.5.3.1.1.`,
    );
  }
  if (name !== undefined) {
    rejectCRLF(`${field} display name`, name);
    // An ASCII name with specials is rendered as one quoted-string, which
    // `foldHeader` never splits: ` "name"` is a line of at least 3 octets
    // plus the name. Same reason as the filename guard above — the escaping
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
  if (att.contentType !== undefined) {
    rejectCRLF('attachment contentType', att.contentType);
  }
  if (att.contentId !== undefined) {
    rejectCRLF('attachment contentId', att.contentId);
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
 * output itself: each finished line is one flat string in `lines`. The
 * earlier shape — tokenize the whole value into an array of slices, wrap
 * each in a `{ text, comma }` object, then grow the result with `out +=`
 * per token — held about 130 bytes of heap per token for the length of the
 * fold (a slice, an object and a cons-string node each), so a legal 3 MB
 * subject of one-letter words terminated a 128 MB isolate. That was a
 * per-TOKEN cost, invisible to any size projection: the message fit.
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
 * with NO allocation. The earlier `text.split(CRLF)` held one array slot and
 * one substring per line for the whole scan, and a legal body of millions of
 * short lines — pasted logs, say — is millions of lines. Only a CRLF pair
 * ends a line, exactly as the split did; a bare CR or LF is content.
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
 * Note this file's own `foldHeader` already tracks quoted-pairs when
 * folding, so the emitter was contradicting the folder.
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

/**
 * Whether a body must be quoted-printable encoded: anything outside
 * printable ASCII, or any line longer than 990 characters (RFC 5322 §2.1.1
 * makes 998 octets the hard limit). Only LF and CRLF end a line; a bare CR
 * is a control character like any other and forces the encoding.
 *
 * One pass over the string with NO allocation. The earlier shape — strip
 * every line break with a global `replace`, test the copy, then `split` the
 * text into an array of lines — was linear in the message but held a copy
 * of the body plus one array slot and one substring per line, and a legal
 * 6 MB body of millions of two-character lines needed 64 MB for the strip
 * and another 24-40 MB for the split. Those are per-LINE costs, invisible
 * to any size projection: the message fit.
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
  return bytesToAsciiString(out);
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
 *   message that fits. Measured before the name was charged, 60k empty
 *   headers with 500-character names — a 30 MB message — projected to
 *   zero, rendered in full and peaked at 121 MB of a 128 MB isolate; 100k
 *   of them (50 MB) went to 169 MB.
 * - An attachment part: `normalizeAttachment` bounds ONE filename at under
 *   a kilobyte, not the sum, and a message is free to carry any number of
 *   parts, so the filename and the framing every part is wrapped in are
 *   the whole size of a message of empty attachments. Measured, 50k
 *   zero-byte attachments with legal 986-character filenames rendered to
 *   106 MB — held three to four times over between the parts, their join,
 *   `rawText` and `raw` — and terminated a 128 MB isolate before the final
 *   size check could return `MIME_ERROR`.
 *
 * The header COUNT is deliberately not bounded here. Each header now costs
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
