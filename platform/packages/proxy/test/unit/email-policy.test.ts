import { describe, expect, it } from 'vite-plus/test';
import {
  RECIPIENT_POLICY_KEY,
  VERIFIED_ONLY,
  readAllowlist,
  readRecipientPolicy,
  recipientAllowed,
  recipientRefusalMessage,
  type RecipientPolicy,
} from '../../src/email-policy.ts';

function kvWith(entries: Record<string, string>): KVNamespace {
  const store = new Map(Object.entries(entries));
  return {
    get: async (key: string) => store.get(key) ?? null,
  } as unknown as KVNamespace;
}

const allowlist = new Set(['dev@example.com']);
const domainsPolicy: RecipientPolicy = { mode: 'domains', domains: new Set(['acme.test']) };
const anyPolicy: RecipientPolicy = { mode: 'any', domains: new Set() };

describe('recipientAllowed', () => {
  it.each([
    // mode, allowlisted, same-domain, other → expected
    ['verified', VERIFIED_ONLY, [true, false, false]],
    ['domains', domainsPolicy, [true, true, false]],
    ['any', anyPolicy, [true, true, true]],
  ] as const)('%s mode decision table', (_mode, policy, expected) => {
    expect([
      recipientAllowed(policy, allowlist, 'dev@example.com'),
      recipientAllowed(policy, allowlist, 'someone@acme.test'),
      recipientAllowed(policy, allowlist, 'someone@other.test'),
    ]).toEqual([...expected]);
  });

  it('matches the recipient domain after the LAST @ only', () => {
    expect(recipientAllowed(domainsPolicy, new Set(), 'a@b@acme.test')).toBe(true);
    expect(recipientAllowed(domainsPolicy, new Set(), 'acme.test')).toBe(false);
    expect(recipientAllowed(domainsPolicy, new Set(), '@acme.test')).toBe(false);
    expect(recipientAllowed(domainsPolicy, new Set(), 'x@sub.acme.test')).toBe(false);
  });
});

describe('recipientRefusalMessage', () => {
  it('names the policy only under `domains`', () => {
    expect(recipientRefusalMessage(VERIFIED_ONLY, 'x@y.test')).toBe(
      "recipient 'x@y.test' is not a verified destination for this project",
    );
    expect(recipientRefusalMessage(domainsPolicy, 'x@y.test')).toBe(
      "recipient 'x@y.test' is not a verified destination for this project and its domain is not in the platform's recipient policy",
    );
  });
});

describe('readRecipientPolicy', () => {
  it('reads a `domains` policy and lowercases its entries', async () => {
    const policy = await readRecipientPolicy(
      kvWith({
        [RECIPIENT_POLICY_KEY]: JSON.stringify({ mode: 'domains', domains: ['Acme.TEST'] }),
      }),
    );
    expect(policy.mode).toBe('domains');
    expect([...policy.domains]).toEqual(['acme.test']);
  });

  it('reads `any`', async () => {
    const policy = await readRecipientPolicy(
      kvWith({ [RECIPIENT_POLICY_KEY]: JSON.stringify({ mode: 'any', domains: [] }) }),
    );
    expect(policy.mode).toBe('any');
  });

  it.each([
    ['absent', undefined],
    ['malformed JSON', '{nope'],
    ['a JSON array', JSON.stringify(['acme.test'])],
    ['null', 'null'],
    ['an unknown mode', JSON.stringify({ mode: 'open', domains: [] })],
    ['`any` without a list', JSON.stringify({ mode: 'any' })],
    ['`any` with a non-array list', JSON.stringify({ mode: 'any', domains: 'corrupt' })],
    ['`domains` without a list', JSON.stringify({ mode: 'domains' })],
    ['`domains` with an empty list', JSON.stringify({ mode: 'domains', domains: [] })],
    ['`domains` with only non-strings', JSON.stringify({ mode: 'domains', domains: [1, null] })],
  ])('falls back to verified-only when the mirror is %s', async (_label, raw) => {
    const policy = await readRecipientPolicy(
      kvWith(raw === undefined ? {} : { [RECIPIENT_POLICY_KEY]: raw }),
    );
    expect(policy).toBe(VERIFIED_ONLY);
  });
});

describe('readAllowlist', () => {
  it('lowercases string entries and skips the rest', async () => {
    const set = await readAllowlist(
      kvWith({ 'email-allowlist:p1': JSON.stringify(['Dev@Example.com', 42, null]) }),
      'p1',
    );
    expect([...set]).toEqual(['dev@example.com']);
  });

  it.each([
    ['absent', undefined],
    ['not JSON', 'nope'],
    ['not an array', JSON.stringify({ dev: true })],
  ])('reads as empty when the key is %s', async (_label, raw) => {
    const set = await readAllowlist(
      kvWith(raw === undefined ? {} : { 'email-allowlist:p1': raw }),
      'p1',
    );
    expect(set.size).toBe(0);
  });
});
