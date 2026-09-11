/**
 * Platform-side destination verification email.
 *
 * When project A adds an address that another project already verified
 * via Cloudflare Email Routing, we cannot trust CF's verified flag for
 * per-project consent (Option C+B from the email design doc): the
 * recipient consented to project B, not project A. We issue our own
 * confirmation email with a single-use HMAC link and only flip the row
 * to 'verified' when the recipient clicks it.
 *
 * Sending mechanics: the api worker doesn't hold the per-tenant sender
 * — only the proxy worker does. We POST to the proxy's
 * `/email/internal/send` endpoint, authenticated with an HMAC of a fixed
 * sentinel string under JWT_SECRET (a value only the proxy and api
 * hold). User workers never see JWT_SECRET, so they can't forge
 * platform-internal sends.
 *
 * Best-effort for DELIVERY: the destination row is already inserted as
 * 'pending' before we get here. If the send fails, the row stays pending
 * and a repeat `POST /projects/:id/email/destinations` for the same
 * address (`void email allow <address>` again) resends the link, so we
 * log and return rather than throw.
 *
 * NOT best-effort for CONFIGURATION: a missing `EMAIL_SENDER_DOMAIN`
 * throws before anything is attempted. Every send from this worker would
 * fail the same way, and a log line among the transient-failure lines is
 * exactly how that goes unnoticed.
 */

import type { ApiEnv } from '../env.ts';

/**
 * Sentinel string the proxy expects in the HMAC.
 *
 * THE definition. The proxy worker is a separate bundle and cannot import
 * from `packages/api`, so it mirrors this literal — keep the two in sync,
 * and change them in the same commit. Bumping this value (e.g. to `-v2`)
 * invalidates every in-flight platform-internal send token in exchange
 * for forcing a coordinated proxy + api deploy; today there is no reason
 * to bump it.
 */
export const PLATFORM_INTERNAL_EMAIL_SENTINEL = 'void-platform-internal-email-v1';

/**
 * `From` for platform-issued verification mail, built from the
 * per-environment `EMAIL_SENDER_DOMAIN` var so production and staging
 * each ride their own DKIM/SPF/DMARC configuration. The proxy's
 * `/email/internal/send` allow-lists exactly `noreply@<its own
 * EMAIL_SENDER_DOMAIN>`, so the two vars must name the same domain
 * within one environment.
 *
 * Deliberately NOT defaulted: a fallback to the production domain would
 * make a misconfigured staging worker sign mail for a domain it has no
 * business sending from — and the proxy would reject it anyway, turning
 * a config error into a silent 403 per send. Throwing surfaces it once,
 * with the var name in the message.
 */
function resolveFromAddress(env: ApiEnv['Bindings']): string {
  const domain = env.EMAIL_SENDER_DOMAIN?.trim();
  if (!domain) {
    throw new Error(
      'EMAIL_SENDER_DOMAIN is not configured on the api worker; refusing to send platform verification mail',
    );
  }
  return `noreply@${domain}`;
}

/**
 * Resolve the public host for the confirmation link. Production is
 * `api.void.cloud`; staging gates on `PLATFORM_ENV` because Access
 * blocks staging API publicly anyway and we still want the link to
 * point at the right environment for ops/testing.
 *
 * `SITE_DOMAIN` is intentionally NOT used here — that constant is the
 * user-app domain (`void.app`), not the api host.
 */
function resolveApiHost(env: ApiEnv['Bindings']): string {
  if (env.PLATFORM_ENV === 'staging') {
    return 'api.staging.void.cloud';
  }
  // Local dev (PLATFORM_ENV unset / 'development' / etc.) falls through
  // to api.void.cloud — local-dev clicks should test against the dev
  // api worker by overriding SITE_DOMAIN if needed.
  return env.SITE_DOMAIN && /^api\./.test(env.SITE_DOMAIN) ? env.SITE_DOMAIN : 'api.void.cloud';
}

/**
 * Resolve the proxy worker's public URL the same way. The api worker has
 * no service binding to the proxy today — we go through CF's public edge.
 */
function resolveProxyOrigin(env: ApiEnv['Bindings']): string {
  if (env.PLATFORM_ENV === 'staging') {
    return 'https://proxy.staging.void.cloud';
  }
  return 'https://proxy.void.cloud';
}

/**
 * Build a minimal RFC 5322 `text/plain` message and base64-encode it.
 * No attachments, no multipart — just the confirmation link plus a short
 * explanation. CRLF terminators are mandatory for SMTP.
 */
function buildVerificationMime(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.body,
    '',
  ];
  const mime = lines.join('\r\n');
  return base64Encode(new TextEncoder().encode(mime));
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

const encoder = new TextEncoder();
let cachedKey: CryptoKey | undefined;
let cachedSecret: string | undefined;

/**
 * Sign `<sentinel>.<unix-seconds>.<contentSha256Hex>`. The proxy
 * verifies the same concatenation and rejects timestamps outside a
 * 5-minute window.
 *
 * Why bind content into the HMAC: without it, a single observed
 * platformToken+timestamp pair could be replayed by an attacker who
 * intercepted the request to send ARBITRARY mail (different recipient,
 * different subject, different attachments) within the timestamp
 * window. Hashing `${from}|${to}|${mimeBase64}` into the signed value
 * pins the token to one specific message — replay still works for the
 * same exact message, but that's the desired idempotency surface.
 *
 * Encoding choices:
 *   - `|` separator inside the content hash input is safe because no
 *     legal email address or base64 character is `|`.
 *   - SHA-256 hex (lowercase) is the bytes-on-the-wire format the
 *     proxy reproduces and compares against. base64url would save 22
 *     bytes but loses nothing operationally; hex is easier to grep
 *     for in tail logs.
 */
async function signSentinelAtBound(
  secret: string,
  unixSeconds: number,
  contentSha256Hex: string,
): Promise<string> {
  if (!cachedKey || cachedSecret !== secret) {
    cachedKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    cachedSecret = secret;
  }
  const message = `${PLATFORM_INTERNAL_EMAIL_SENTINEL}.${unixSeconds}.${contentSha256Hex}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cachedKey, encoder.encode(message)));
  let binary = '';
  for (const b of sig) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Hash `${from}|${to}|${mimeBase64}` to lowercase hex. Exposed so the
 * proxy verification helper can reproduce the same hash bit-for-bit.
 */
export async function hashSendContent(
  from: string,
  to: string,
  mimeBase64: string,
): Promise<string> {
  const input = `${from}|${to}|${mimeBase64}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)));
  let hex = '';
  for (const b of digest) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sendPlatformVerificationEmail(
  env: ApiEnv['Bindings'],
  project: { id: string; slug: string },
  address: string,
  token: string,
): Promise<void> {
  // Resolved OUTSIDE the try: a missing `EMAIL_SENDER_DOMAIN` is a deploy
  // misconfiguration, not a delivery failure, and must not be swallowed
  // into a log line that reads like a transient proxy error.
  const fromAddress = resolveFromAddress(env);

  try {
    const apiHost = resolveApiHost(env);
    const link = `https://${apiHost}/email/destinations/confirm?token=${encodeURIComponent(token)}`;
    const subject = `[${project.slug}] wants permission to email you`;
    const body = [
      `The Void project "${project.slug}" wants permission to send email to`,
      `${address}.`,
      '',
      'Click to confirm:',
      link,
      '',
      'This link expires in 24 hours and can only be used once.',
      '',
      "If you didn't expect this email, ignore it — no permission is granted",
      'until the link is clicked.',
    ].join('\r\n');

    const mimeBase64 = buildVerificationMime({
      from: fromAddress,
      to: address,
      subject,
      body,
    });

    const platformTimestamp = Math.floor(Date.now() / 1000);
    const contentSha256 = await hashSendContent(fromAddress, address, mimeBase64);
    const platformToken = await signSentinelAtBound(
      env.JWT_SECRET,
      platformTimestamp,
      contentSha256,
    );
    const url = `${resolveProxyOrigin(env)}/email/internal/send`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platformToken,
        platformTimestamp,
        from: fromAddress,
        to: address,
        mimeBase64,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(
        `[email-verify] proxy /email/internal/send returned ${res.status} for project=${project.id} address=${address}: ${detail.slice(0, 240)}`,
      );
    }
  } catch (err) {
    console.error(
      `[email-verify] platform verification email failed for project=${project.id} address=${address}:`,
      err,
    );
  }
}
