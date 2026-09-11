import { describe, it, expect } from 'vite-plus/test';
import { isAllowedRedirect } from '../../src/routes/auth.ts';

describe('isAllowedRedirect gates auth code delivery', () => {
  it('allows localhost redirects', () => {
    expect(isAllowedRedirect('http://localhost:5173/auth/callback')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:3000/auth/callback')).toBe(true);
  });

  it('allows dashboard origin', () => {
    expect(isAllowedRedirect('https://dash.void.cloud/auth/callback')).toBe(true);
  });

  it('rejects attacker domains', () => {
    expect(isAllowedRedirect('https://evil.com/auth/callback')).toBe(false);
  });

  it('rejects subdomain prefix attacks', () => {
    expect(isAllowedRedirect('https://dash.void.cloud.attacker.com/steal')).toBe(false);
  });

  it('rejects HTTPS localhost', () => {
    expect(isAllowedRedirect('https://localhost:3000/callback')).toBe(false);
  });
});
