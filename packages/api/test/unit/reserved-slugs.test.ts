import { describe, it, expect } from 'vite-plus/test';
import { RESERVED_SLUGS } from '../../src/routes/projects.ts';

describe('reserved slugs (real implementation)', () => {
  it('blocks cname slug (CNAME target)', () => {
    expect(RESERVED_SLUGS.has('cname')).toBe(true);
  });

  it('blocks platform-related slugs', () => {
    for (const slug of ['admin', 'api', 'dash', 'dashboard', 'proxy', 'staging']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  it('blocks infrastructure slugs', () => {
    for (const slug of ['mail', 'smtp', 'ns1', 'ns2', 'ftp']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  // A project's outbound `from` is `<slug>[+tag]@<EMAIL_SENDER_DOMAIN>`, so a
  // slug IS a mailbox on the platform mail domain. `noreply` is the platform's
  // own verification sender — the proxy's internal allow-list is exactly
  // `noreply@<domain>` — and the rest are the addresses recipients and mail
  // providers treat as authoritative for a whole domain.
  it('blocks email-identity slugs', () => {
    for (const slug of ['noreply', 'postmaster', 'abuse', 'bounce', 'security']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
  });

  it('allows normal project slugs', () => {
    for (const slug of ['my-app', 'cool-project', 'hello-world', 'test123']) {
      expect(RESERVED_SLUGS.has(slug)).toBe(false);
    }
  });

  it('has a reasonable minimum size', () => {
    expect(RESERVED_SLUGS.size).toBeGreaterThanOrEqual(30);
  });
});
