/** Installation email policy is authoritative in Postgres. KV is a display hint. */

import { desc, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { generateId } from '../id.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { emailProjectControls } from './admission-schema.ts';
import { emailCacheOutbox } from './connection-schema.ts';
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

async function latestPolicyOutbox(db: DbOrTx) {
  const [latest] = await db
    .select()
    .from(emailCacheOutbox)
    .where(eq(emailCacheOutbox.resource_kind, 'policy'))
    .orderBy(desc(emailCacheOutbox.version))
    .limit(1);
  return latest;
}

/** Commit the policy and its publication intent under the admission policy lock. */
export async function setEmailRecipientPolicy(
  db: Db,
  kv: KVNamespace,
  policy: EmailRecipientPolicy,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('email-admission:policy'))`);
    const latest = await latestPolicyOutbox(tx);
    const version = (latest?.version ?? 0) + 1;
    await setPlatformSetting(tx, EMAIL_RECIPIENT_POLICY_SETTING, {
      mode: policy.mode,
      domains: [...policy.domains],
    });
    await tx
      .update(emailProjectControls)
      .set({ version: sql`${emailProjectControls.version} + 1` });
    await tx.insert(emailCacheOutbox).values({
      id: generateId('eout'),
      installation_id: 'installation',
      resource_kind: 'policy',
      resource_id: EMAIL_RECIPIENT_POLICY_SETTING,
      version,
      payload: { mode: policy.mode, domains: [...policy.domains] },
    });
  });
  await repairEmailRecipientPolicyMirror(db, kv);
}

/** Immutable version keys prevent a delayed publish from replacing newer data.
 * The unversioned value is a best-effort display hint and never authorizes sends. */
export async function repairEmailRecipientPolicyMirror(db: Db, kv: KVNamespace): Promise<void> {
  try {
    const latest = await latestPolicyOutbox(db);
    const policy = await getEmailRecipientPolicy(db);
    const expected = serializeEmailRecipientPolicyMirror(policy);
    if (latest && !latest.published_at) {
      await kv.put(`email-policy-version:${latest.version}`, JSON.stringify(latest.payload));
      await db
        .update(emailCacheOutbox)
        .set({ published_at: new Date().toISOString() })
        .where(eq(emailCacheOutbox.id, latest.id));
    }
    if ((await kv.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)) !== expected) {
      await kv.put(EMAIL_RECIPIENT_POLICY_MIRROR_KEY, expected);
    }
  } catch (error) {
    console.error('[email-settings] display mirror publication failed:', error);
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
