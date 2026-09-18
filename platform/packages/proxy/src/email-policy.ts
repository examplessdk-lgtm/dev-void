/**
 * The shared-sender recipient gate (design doc 0078, "Recipient policy").
 *
 * Two KV reads decide whether a recipient may be mailed from a project's
 * `<slug>+tag@<EMAIL_SENDER_DOMAIN>` address: the project's verified
 * destinations (`email-allowlist:<projectId>`) and one installation-wide
 * policy (`email-recipient-policy`), both mirrored by the api. The policy
 * can only widen the allowlist; an absent or unreadable policy mirror is the
 * default `verified` mode, so a failed publish never loosens the gate.
 *
 * The custom-domain lane does not use this gate at all (the customer's own
 * Email Sending onboarding lifts Cloudflare's destination check there).
 */

export type RecipientPolicyMode = 'verified' | 'domains' | 'any';

export type RecipientPolicy = Readonly<{
  mode: RecipientPolicyMode;
  /** Lowercased recipient domains; only populated for `domains`. */
  domains: ReadonlySet<string>;
}>;

export const RECIPIENT_POLICY_KEY = 'email-recipient-policy';

/** Mirrors the api's `MAX_POLICY_DOMAINS`; a longer list is not the api's. */
const MAX_POLICY_DOMAINS = 100;

export const VERIFIED_ONLY: RecipientPolicy = Object.freeze({
  mode: 'verified',
  domains: new Set<string>(),
});

/**
 * Reads `email-recipient-policy`. `cacheTtl` bounds per-colo convergence at
 * ~60s, like the allowlist. Anything that is not `{ mode, domains[] }` with
 * a known mode reads as `verified`.
 */
export async function readRecipientPolicy(kv: KVNamespace): Promise<RecipientPolicy> {
  const raw = await kv.get(RECIPIENT_POLICY_KEY, { cacheTtl: 60 });
  if (!raw) {
    return VERIFIED_ONLY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return VERIFIED_ONLY;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return VERIFIED_ONLY;
  }
  const { mode, domains } = parsed as { mode?: unknown; domains?: unknown };
  // The api writes exactly `{ mode: 'any', domains: [] }` or
  // `{ mode: 'domains', domains: [1..100 non-empty lowercase strings] }`.
  // Anything else is not the api's mirror and must not widen the gate.
  if (!Array.isArray(domains) || domains.length > MAX_POLICY_DOMAINS) {
    return VERIFIED_ONLY;
  }
  if (mode === 'any') {
    return domains.length === 0 ? { mode: 'any', domains: new Set() } : VERIFIED_ONLY;
  }
  if (mode === 'domains') {
    if (domains.length === 0 || !domains.every((d) => typeof d === 'string' && d !== '')) {
      return VERIFIED_ONLY;
    }
    return { mode: 'domains', domains: new Set(domains.map((d) => d.toLowerCase())) };
  }
  return VERIFIED_ONLY;
}

/**
 * Reads `email-allowlist:<projectId>` — a JSON array of lowercased verified
 * addresses the api writes on every destination CRUD, on the platform
 * confirmation click, and as the repair for a stale key. A missing key reads
 * as empty, so a brand-new project has every recipient refused.
 */
export async function readAllowlist(kv: KVNamespace, projectId: string): Promise<Set<string>> {
  const raw = await kv.get(`email-allowlist:${projectId}`, { cacheTtl: 60 });
  if (!raw) {
    return new Set();
  }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      return new Set();
    }
    const out = new Set<string>();
    for (const v of arr) {
      if (typeof v === 'string') {
        out.add(v.toLowerCase());
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * `recipient` is already lowercased by the caller. `platformDomain` is the
 * installation's own mail domain (`EMAIL_SENDER_DOMAIN`): the policy never
 * widens delivery to addresses on it, so one tenant cannot use `any` or a
 * listed platform domain to mail another tenant's `<slug>+tag@` inbox — or
 * form a reply loop with it — without that recipient's own consent.
 */
export function recipientAllowed(
  policy: RecipientPolicy,
  allowlist: ReadonlySet<string>,
  recipient: string,
  platformDomain?: string,
): boolean {
  if (allowlist.has(recipient)) {
    return true;
  }
  const at = recipient.lastIndexOf('@');
  const domain = at > 0 ? recipient.slice(at + 1) : '';
  if (platformDomain !== undefined && domain === platformDomain.toLowerCase()) {
    return false;
  }
  if (policy.mode === 'any') {
    return true;
  }
  return policy.mode === 'domains' && domain !== '' && policy.domains.has(domain);
}

/** The per-recipient `UNVERIFIED_DESTINATION` message for a refused recipient. */
export function recipientRefusalMessage(policy: RecipientPolicy, recipient: string): string {
  const base = `recipient '${recipient}' is not a verified destination for this project`;
  return policy.mode === 'domains'
    ? `${base} and its domain is not in the platform's recipient policy`
    : base;
}
