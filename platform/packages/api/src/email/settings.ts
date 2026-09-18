/**
 * Installation-wide email settings (design doc 0078, "Recipient policy" and
 * "Administrator-managed domains"). Authoritative in `platform_settings`;
 * the recipient policy is also mirrored to ROUTING KV because the proxy
 * reads it on every shared-sender send and has no database.
 *
 * The mirror is a wire contract with `packages/proxy/src/email-policy.ts`:
 * key `email-recipient-policy`, value `JSON.stringify(policy)`. An absent or
 * unreadable mirror reads as `verified` there — today's behavior — so a
 * failed publish can only tighten, never loosen, what the proxy enforces.
 */

import { sql } from 'drizzle-orm';
import type { Db, DbOrTx, Tx } from '../db.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { isValidEmailDomain, MAX_DOMAIN_LENGTH, normalizeEmailDomain } from './domain-name.ts';

export type EmailRecipientPolicyMode = 'verified' | 'domains' | 'any';
export type EmailRecipientPolicy = Readonly<{
  mode: EmailRecipientPolicyMode;
  domains: ReadonlyArray<string>;
}>;
export type EmailDomainManagement = 'self-serve' | 'admin';

export const EMAIL_RECIPIENT_POLICY_SETTING = 'email.recipientPolicy';
export const EMAIL_DOMAIN_MANAGEMENT_SETTING = 'email.domains';
export const EMAIL_RECIPIENT_POLICY_MIRROR_KEY = 'email-recipient-policy';
export const DEFAULT_EMAIL_RECIPIENT_POLICY: EmailRecipientPolicy = {
  mode: 'verified',
  domains: [],
};
export const MAX_POLICY_DOMAINS = 100;

const POLICY_MODES: ReadonlyArray<EmailRecipientPolicyMode> = ['verified', 'domains', 'any'];
const MANAGEMENT_MODES: ReadonlyArray<EmailDomainManagement> = ['self-serve', 'admin'];

export class EmailSettingsError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'EmailSettingsError';
  }
}

export function isEmailDomainManagement(value: unknown): value is EmailDomainManagement {
  return typeof value === 'string' && (MANAGEMENT_MODES as ReadonlyArray<string>).includes(value);
}

/**
 * Validates operator input `{ mode, domains? }`. `domains` may be an array
 * or one comma/whitespace-separated string; entries are normalized like a
 * registered email domain. Only `domains` mode keeps a list, and it must
 * not be empty — an empty list would be `verified` wearing another name.
 */
export function normalizeEmailRecipientPolicy(input: unknown): EmailRecipientPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EmailSettingsError('recipient policy must be an object with a mode');
  }
  const { mode, domains } = input as { mode?: unknown; domains?: unknown };
  if (typeof mode !== 'string' || !(POLICY_MODES as ReadonlyArray<string>).includes(mode)) {
    throw new EmailSettingsError(`mode must be one of ${POLICY_MODES.join(', ')}`);
  }
  if (mode !== 'domains') {
    return { mode: mode as EmailRecipientPolicyMode, domains: [] };
  }
  const raw: Array<unknown> =
    domains === undefined || domains === null
      ? []
      : typeof domains === 'string'
        ? domains.split(/[\s,]+/)
        : Array.isArray(domains)
          ? domains
          : [domains];
  const normalized = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new EmailSettingsError('domains must be strings');
    }
    if (entry.trim() === '') {
      continue;
    }
    if (entry.length > MAX_DOMAIN_LENGTH) {
      throw new EmailSettingsError('a recipient domain is too long');
    }
    const domain = normalizeEmailDomain(entry);
    if (!isValidEmailDomain(domain)) {
      throw new EmailSettingsError(`'${entry.trim()}' is not a valid domain`);
    }
    normalized.add(domain);
  }
  if (normalized.size === 0) {
    throw new EmailSettingsError('mode domains needs at least one recipient domain');
  }
  if (normalized.size > MAX_POLICY_DOMAINS) {
    throw new EmailSettingsError(`at most ${MAX_POLICY_DOMAINS} recipient domains`);
  }
  return { mode: 'domains', domains: [...normalized].sort() };
}

function readStoredPolicy(value: unknown): EmailRecipientPolicy | null {
  try {
    return normalizeEmailRecipientPolicy(value);
  } catch {
    return null;
  }
}

export async function getEmailRecipientPolicy(db: DbOrTx): Promise<EmailRecipientPolicy> {
  const stored = await getPlatformSetting(db, EMAIL_RECIPIENT_POLICY_SETTING);
  if (stored === null) {
    return DEFAULT_EMAIL_RECIPIENT_POLICY;
  }
  const policy = readStoredPolicy(stored);
  if (policy === null) {
    console.error(
      `[email-settings] ${EMAIL_RECIPIENT_POLICY_SETTING} is malformed; enforcing the default policy`,
    );
    return DEFAULT_EMAIL_RECIPIENT_POLICY;
  }
  return policy;
}

export function serializeEmailRecipientPolicyMirror(policy: EmailRecipientPolicy): string {
  return JSON.stringify({ mode: policy.mode, domains: [...policy.domains] });
}

/**
 * The publisher and the repair serialize on one transaction-scoped advisory
 * lock, so their read → compare → put sequences never interleave: KV has no
 * compare-and-set, and without the lock a repair that read an older policy
 * could land its put after a newer publish and reopen a gate the operator
 * had just closed. The lock is held across the KV calls on purpose — the
 * same total-order trick the email-domain mirror uses with the project row.
 */
function withRecipientPolicyLock<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${EMAIL_RECIPIENT_POLICY_SETTING}))`,
    );
    return fn(tx);
  });
}

/**
 * Publish in two locked steps: (1) delete the mirror and commit the new
 * database value; (2) republish the mirror FROM the committed value. The
 * mirror is therefore never ahead of the database — a put that lands
 * without its response, or a commit that fails, cannot leave a policy in
 * force that the database does not hold. Every partial outcome fails
 * closed: an absent mirror reads as `verified` at the proxy, and whatever
 * the database holds is what step (2) or the next read republishes.
 */
export async function setEmailRecipientPolicy(
  db: Db,
  kv: KVNamespace,
  policy: EmailRecipientPolicy,
): Promise<void> {
  await withRecipientPolicyLock(db, async (tx) => {
    try {
      await kv.delete(EMAIL_RECIPIENT_POLICY_MIRROR_KEY);
    } catch (err) {
      console.error('[email-settings] recipient policy mirror clear failed:', err);
      throw new Error('the recipient policy routing mirror could not be updated; nothing changed');
    }
    await setPlatformSetting(tx, EMAIL_RECIPIENT_POLICY_SETTING, {
      mode: policy.mode,
      domains: [...policy.domains],
    });
  });
  try {
    await publishEmailRecipientPolicyMirror(db, kv);
  } catch (err) {
    console.error('[email-settings] recipient policy mirror write failed:', err);
    throw new Error(
      'recipient policy saved; publishing it to routing failed and it reads as verified until a retry or the next read republishes it',
    );
  }
}

/** Under the publish lock: read the committed policy and put the mirror when it differs. */
async function publishEmailRecipientPolicyMirror(db: Db, kv: KVNamespace): Promise<void> {
  await withRecipientPolicyLock(db, async (tx) => {
    const [policy, mirrored] = await Promise.all([
      getEmailRecipientPolicy(tx),
      kv.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY),
    ]);
    const expected = serializeEmailRecipientPolicyMirror(policy);
    if (mirrored !== expected) {
      await kv.put(EMAIL_RECIPIENT_POLICY_MIRROR_KEY, expected);
    }
  });
}

/** Best-effort read-compare repair of the mirror; never throws. */
export async function repairEmailRecipientPolicyMirror(db: Db, kv: KVNamespace): Promise<void> {
  try {
    await publishEmailRecipientPolicyMirror(db, kv);
  } catch (err) {
    console.error('[email-settings] recipient policy mirror repair failed:', err);
  }
}

export async function getEmailDomainManagement(db: DbOrTx): Promise<EmailDomainManagement> {
  const stored = await getPlatformSetting(db, EMAIL_DOMAIN_MANAGEMENT_SETTING);
  return isEmailDomainManagement(stored) ? stored : 'self-serve';
}

export async function setEmailDomainManagement(
  db: DbOrTx,
  mode: EmailDomainManagement,
): Promise<void> {
  await setPlatformSetting(db, EMAIL_DOMAIN_MANAGEMENT_SETTING, mode);
}
