import { describe, expect, it } from 'vite-plus/test';
import { isPlatformAccessIdentityRule } from '../../src/access-policy.ts';

const anyLoginMethod = () => true;

describe('isPlatformAccessIdentityRule', () => {
  it.each([
    { cloudflare_account_member: {} },
    { cloudflare_account_member: { account_id: '023e105f4ecef8ad9ca31a8372d0c353' } },
  ])('counts Cloudflare account members as company identities (%j)', (rule) => {
    expect(isPlatformAccessIdentityRule(rule, anyLoginMethod)).toBe(true);
  });

  it.each([
    { cloudflare_account_member: true },
    { cloudflare_account_member: [] },
    { cloudflare_account_member: { account_id: '' } },
    { cloudflare_account_member: { account_id: '*' } },
    { cloudflare_account_member: { account_id: 123 } },
  ])('rejects a malformed Cloudflare account member rule (%j)', (rule) => {
    expect(isPlatformAccessIdentityRule(rule, anyLoginMethod)).toBe(false);
  });
});
