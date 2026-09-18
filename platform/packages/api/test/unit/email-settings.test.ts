import { describe, expect, it } from 'vite-plus/test';
import {
  EmailSettingsError,
  MAX_POLICY_DOMAINS,
  normalizeEmailRecipientPolicy,
  serializeEmailRecipientPolicyMirror,
} from '../../src/email/settings.ts';

describe('normalizeEmailRecipientPolicy', () => {
  it('accepts a comma/whitespace-separated string and normalizes it', () => {
    expect(
      normalizeEmailRecipientPolicy({
        mode: 'domains',
        domains: ' Corp.Example,\nexample.net corp.example. ',
      }),
    ).toEqual({ mode: 'domains', domains: ['corp.example', 'example.net'] });
  });

  it('accepts an array and dedupes case-insensitively', () => {
    expect(
      normalizeEmailRecipientPolicy({
        mode: 'domains',
        domains: ['A.Example', 'a.example', 'b.example'],
      }),
    ).toEqual({ mode: 'domains', domains: ['a.example', 'b.example'] });
  });

  it('drops the list for `verified` and `any`', () => {
    expect(normalizeEmailRecipientPolicy({ mode: 'any', domains: 'x.example' })).toEqual({
      mode: 'any',
      domains: [],
    });
    expect(normalizeEmailRecipientPolicy({ mode: 'verified' })).toEqual({
      mode: 'verified',
      domains: [],
    });
  });

  it.each([
    ['a non-object', 'domains'],
    ['a missing mode', {}],
    ['an unknown mode', { mode: 'open' }],
    ['`domains` without a list', { mode: 'domains' }],
    ['`domains` with only blanks', { mode: 'domains', domains: ' , ' }],
    ['a non-string entry', { mode: 'domains', domains: [42] }],
    ['a single-label domain', { mode: 'domains', domains: 'localhost' }],
    ['a domain with spaces', { mode: 'domains', domains: ['not a domain'] }],
    ['an over-long domain', { mode: 'domains', domains: `${'a'.repeat(254)}.example` }],
    [
      'more than the cap',
      {
        mode: 'domains',
        domains: Array.from({ length: MAX_POLICY_DOMAINS + 1 }, (_, i) => `d${i}.example`),
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeEmailRecipientPolicy(input)).toThrow(EmailSettingsError);
  });
});

describe('serializeEmailRecipientPolicyMirror', () => {
  it('is the exact wire shape the proxy parses', () => {
    expect(serializeEmailRecipientPolicyMirror({ mode: 'domains', domains: ['a.example'] })).toBe(
      '{"mode":"domains","domains":["a.example"]}',
    );
  });
});
