export type AllowlistEntry = Readonly<{
  type: 'github' | 'email';
  pattern: string;
  note?: string;
}>;

const KV_KEY = 'signup:allowlist';

export async function getAllowlist(kv: KVNamespace): Promise<Array<AllowlistEntry>> {
  const raw = await kv.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function putAllowlist(
  kv: KVNamespace,
  entries: ReadonlyArray<AllowlistEntry>,
): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(entries));
}

/**
 * Check if a signup should be allowed based on the allowlist.
 * If entries is empty, no one is allowed (restrictions are on but nobody is listed).
 */
export function isSignupAllowed(
  provider: string,
  login: string,
  email: string | null,
  entries: ReadonlyArray<AllowlistEntry>,
): boolean {
  if (entries.length === 0) {
    return false;
  }

  return entries.some((entry) => {
    if (entry.type === 'github') {
      return provider === 'github' && entry.pattern.toLowerCase() === login.toLowerCase();
    }
    // email entry — matches any provider if they have a matching email
    if (!email) {
      return false;
    }
    if (entry.pattern.startsWith('*@')) {
      const domain = entry.pattern.slice(1).toLowerCase();
      return email.toLowerCase().endsWith(domain);
    }
    return entry.pattern.toLowerCase() === email.toLowerCase();
  });
}
