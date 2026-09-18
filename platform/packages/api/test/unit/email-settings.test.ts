import { describe, expect, it } from 'vite-plus/test';
import {
  EmailSettingsError,
  MAX_POLICY_DOMAINS,
  normalizeEmailRecipientPolicy,
  serializeEmailRecipientPolicyMirror,
  widensEmailRecipientPolicy,
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

describe('widensEmailRecipientPolicy', () => {
  it.each([
    [
      'verified → domains',
      { mode: 'verified', domains: [] },
      { mode: 'domains', domains: ['a.example'] },
      true,
    ],
    [
      'domains → any',
      { mode: 'domains', domains: ['a.example'] },
      { mode: 'any', domains: [] },
      true,
    ],
    [
      'any → domains',
      { mode: 'any', domains: [] },
      { mode: 'domains', domains: ['a.example'] },
      false,
    ],
    [
      'domains → verified',
      { mode: 'domains', domains: ['a.example'] },
      { mode: 'verified', domains: [] },
      false,
    ],
    [
      'grown domains list',
      { mode: 'domains', domains: ['a.example'] },
      { mode: 'domains', domains: ['a.example', 'b.example'] },
      true,
    ],
    [
      'shrunk domains list',
      { mode: 'domains', domains: ['a.example', 'b.example'] },
      { mode: 'domains', domains: ['a.example'] },
      false,
    ],
    [
      'edited domains list',
      { mode: 'domains', domains: ['a.example', 'b.example'] },
      { mode: 'domains', domains: ['b.example', 'c.example'] },
      true,
    ],
    [
      'pure shrink retaining a different entry',
      { mode: 'domains', domains: ['a.example', 'b.example'] },
      { mode: 'domains', domains: ['b.example'] },
      false,
    ],
    [
      'replaced domains list',
      { mode: 'domains', domains: ['a.example'] },
      { mode: 'domains', domains: ['b.example'] },
      true,
    ],
    [
      'unchanged domains list',
      { mode: 'domains', domains: ['a.example'] },
      { mode: 'domains', domains: ['a.example'] },
      false,
    ],
    ['any → any', { mode: 'any', domains: [] }, { mode: 'any', domains: [] }, false],
  ] as const)('%s: %s', (_label, prev, next, expected) => {
    expect(widensEmailRecipientPolicy(prev, next)).toBe(expected);
  });
});

describe('serializeEmailRecipientPolicyMirror', () => {
  it('is the exact wire shape the proxy parses', () => {
    expect(serializeEmailRecipientPolicyMirror({ mode: 'domains', domains: ['a.example'] })).toBe(
      '{"mode":"domains","domains":["a.example"]}',
    );
  });
});
