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
  if (mode === 'any') {
    return { mode: 'any', domains: new Set() };
  }
  if (mode === 'domains') {
    const set = new Set<string>();
    if (Array.isArray(domains)) {
      for (const d of domains) {
        if (typeof d === 'string' && d !== '') {
          set.add(d.toLowerCase());
        }
      }
    }
    // An empty list is `verified` wearing another name; the api refuses to
    // store one, so treat it the same way here.
    return set.size === 0 ? VERIFIED_ONLY : { mode: 'domains', domains: set };
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

/** `recipient` is already lowercased by the caller. */
export function recipientAllowed(
  policy: RecipientPolicy,
  allowlist: ReadonlySet<string>,
  recipient: string,
): boolean {
  if (policy.mode === 'any') {
    return true;
  }
  if (allowlist.has(recipient)) {
    return true;
  }
  if (policy.mode === 'domains') {
    const at = recipient.lastIndexOf('@');
    return at > 0 && policy.domains.has(recipient.slice(at + 1));
  }
  return false;
}

/** The per-recipient `UNVERIFIED_DESTINATION` message for a refused recipient. */
export function recipientRefusalMessage(policy: RecipientPolicy, recipient: string): string {
  const base = `recipient '${recipient}' is not a verified destination for this project`;
  return policy.mode === 'domains'
    ? `${base} and its domain is not in the platform's recipient policy`
    : base;
}
