import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import { leaseEmailDomainCredential, withEmailDomainRowLock } from '../email/credential-lease.ts';
import {
  decryptEmailDomainRelaySecret,
  hashEmailRelaySecret,
  writeEmailDomainMirror,
} from '../email/domains.ts';
import type { EmailDomainMirror } from '../email/domains.ts';
import type { ApiEnv } from '../env.ts';
import { emailDomains } from '../schema.ts';

const app = new Hono<ApiEnv>();

/**
 * The mirror key spelling is owned by `src/email/domains.ts` (the writer —
 * frozen for this phase). The lease reads the same key the domain
 * mutations write; a rename there must move this spelling with it.
 */
function emailDomainMirrorKey(domain: string): string {
  return `email-domain:${domain}`;
}

/**
 * Credential lease endpoint — called by the proxy via service binding when
 * a send's from-domain is a registered custom domain (design doc 0078,
 * contract 4). Authenticated with the platform-internal pattern the proxy
 * already uses for the revalidation bridge: an HMAC under JWT_SECRET in
 * the `x-void-internal` header. Here the signed value is the DOMAIN — the
 * one value both sides of this call provably hold (the proxy's caller
 * pinning happens on the proxy side, against the mirror, before it calls).
 *
 *   POST /internal/email/domain-credential    { "domain": "acme.com" }
 *   → { kind: 'api_token', token } | { kind: 'oauth_grant', accessToken }
 *
 * The response body IS a customer credential: it is never logged, never
 * interpolated into an error, and never appears in any other payload.
 */
app.post('/', async (context) => {
  let body: { domain?: unknown };
  try {
    body = await context.req.json<{ domain?: unknown }>();
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }
  // Verified verbatim — the HMAC signs the exact string the proxy sent.
  const domain = body.domain;
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) {
    return context.json({ error: 'invalid domain' }, 400);
  }

  const token = context.req.header('x-void-internal');
  if (!token) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (!(await hmacVerifyState(domain, token, context.env.JWT_SECRET))) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }

  // Resolve the row through the same mirror the proxy gated on: the mirror
  // names exactly one project per domain, so a domain registered by two
  // projects leases the credential of the project the proxy saw.
  const mirrorRaw = await context.env.ROUTING.get(emailDomainMirrorKey(domain));
  if (!mirrorRaw) {
    return context.json({ error: 'unknown email domain' }, 404);
  }
  let mirror: EmailDomainMirror;
  try {
    mirror = JSON.parse(mirrorRaw) as EmailDomainMirror;
  } catch {
    return context.json({ error: 'corrupt email domain mirror' }, 500);
  }
  if (typeof mirror.projectId !== 'string' || mirror.projectId.length === 0) {
    return context.json({ error: 'corrupt email domain mirror' }, 500);
  }

  const db = context.get('db');
  const rows = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.project_id, mirror.projectId), eq(emailDomains.domain, domain)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return context.json({ error: 'unknown email domain' }, 404);
  }
  if (row.status !== 'active') {
    return context.json({ error: `email domain is ${row.status}, not active` }, 409);
  }

  const outcome = await leaseEmailDomainCredential(db, context.env, row);
  if (!outcome.ok) {
    if (outcome.status === 'token_revoked') {
      // The row flip was persisted inside the refresh transaction; re-mirror
      // so the proxy stops accepting this domain's relay and sends. The write
      // is fenced through the row lock: the row is re-read FOR UPDATE and the
      // mirror is published from the LOCKED row inside the same transaction,
      // and only while it still holds the credential that was revoked — a
      // replace that committed in between published its own active mirror
      // under the same lock, and this write must not overwrite it with the
      // stale status and relay hash. The row is authoritative, so a KV
      // failure here is logged, not fatal — the next mutation (or status
      // probe) rewrites the mirror.
      try {
        await withEmailDomainRowLock(db, row.id, async (tx) => {
          const locked = await tx
            .select()
            .from(emailDomains)
            .where(eq(emailDomains.id, row.id))
            .for('update')
            .limit(1);
          const current = locked[0];
          if (
            !current ||
            current.status !== 'token_revoked' ||
            current.credential_kind !== row.credential_kind ||
            current.token_ciphertext !== row.token_ciphertext
          ) {
            return;
          }
          const relaySecret = await decryptEmailDomainRelaySecret(
            context.env,
            current.project_id,
            current.domain,
            current,
          );
          await writeEmailDomainMirror(
            context.env.ROUTING,
            current,
            await hashEmailRelaySecret(relaySecret),
          );
        });
      } catch (err) {
        console.error('[email] domain mirror update after revocation failed:', err);
      }
      return context.json({ error: 'email domain credential revoked' }, 403);
    }
    console.error('[email] credential lease failed:', outcome.error);
    return context.json({ error: 'credential lease failed' }, 502);
  }

  return context.json(outcome.lease);
});

export default app;
