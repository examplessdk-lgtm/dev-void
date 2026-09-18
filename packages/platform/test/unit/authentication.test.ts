import { describe, expect, it } from 'vite-plus/test';
import {
  parsePlatformAccessProtection,
  parsePlatformAuthenticationSetup,
  parsePlatformAdmissionPolicy,
  parsePlatformLoginConfiguration,
  parsePlatformLoginDescriptor,
  parsePlatformSignupAllowlistEntry,
  isPlatformSignupAllowed,
  validatePlatformAdmissionPolicy,
} from '../../src/authentication.ts';

const google = { id: 'google', kind: 'google', label: 'Google', clientId: 'client' };
const company = {
  id: 'company',
  kind: 'oidc',
  label: 'Company',
  clientId: 'client',
  issuer: 'https://identity.example.com/realm/',
};
const protection = {
  teamDomain: 'https://example.cloudflareaccess.com',
  applications: [{ origin: 'https://api.example.com', audience: 'expected-app' }],
};

describe('platform authentication configuration', () => {
  it('validates bootstrap authority and preserves opaque client secrets', () => {
    const input = {
      connections: [{ configuration: company, clientSecret: ' opaque-secret ' }],
      administratorConnectionId: 'company',
      bootstrapCredentialHash: 'a'.repeat(64),
      admission: { mode: 'restricted' },
      protection: null,
    };
    expect(parsePlatformAuthenticationSetup(input).connections[0]?.clientSecret).toBe(
      ' opaque-secret ',
    );
    expect(() =>
      parsePlatformAuthenticationSetup({ ...input, bootstrapCredentialHash: 'short' }),
    ).toThrow('SHA-256');
    expect(() =>
      parsePlatformAuthenticationSetup({ ...input, administratorConnectionId: 'missing' }),
    ).toThrow('included');
    expect(() =>
      parsePlatformAuthenticationSetup({
        ...input,
        connections: [...input.connections, ...input.connections],
      }),
    ).toThrow('unique');
  });
  it('keeps Access login and Access protection independent', () => {
    const login = parsePlatformLoginConfiguration({
      ...company,
      kind: 'cloudflare-access',
      issuer: 'https://example.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client',
    });
    expect(login.kind).toBe('cloudflare-access');
    expect(parsePlatformAccessProtection(null)).toBeNull();
    expect(parsePlatformAccessProtection(protection)).toEqual(protection);
  });

  it('uses the fixed Google issuer and exact Workspace domains', () => {
    expect(parsePlatformLoginConfiguration({ ...google, allowedDomains: ['Example.com'] })).toEqual(
      {
        ...google,
        issuer: 'https://accounts.google.com',
        allowedDomains: ['example.com'],
        requiredGroups: [],
      },
    );
    expect(() => parsePlatformLoginConfiguration({ ...google, issuer: company.issuer })).toThrow(
      'Google issuer',
    );
    for (const domains of [['*.example.com'], ['a@example.com'], ['example.com', 'EXAMPLE.COM']]) {
      expect(() =>
        parsePlatformLoginConfiguration({ ...google, allowedDomains: domains }),
      ).toThrow();
    }
  });

  it('preserves significant issuer paths and trailing slashes', () => {
    expect(parsePlatformLoginConfiguration(company).issuer).toBe(company.issuer);
  });

  it.each([
    'http://id.example.com',
    'https://user:secret@id.example.com',
    'https://id.example.com/?key=secret',
    'https://id.example.com/#fragment',
  ])('rejects unsafe issuer syntax %s', (issuer) => {
    expect(() => parsePlatformLoginConfiguration({ ...company, issuer })).toThrow();
  });

  it('public descriptors cannot disclose supplied credentials or endpoints', () => {
    expect(parsePlatformLoginDescriptor({ ...company, clientSecret: 'secret' })).toEqual({
      id: 'company',
      kind: 'oidc',
      label: 'Company',
    });
  });

  it('rejects provider IDs that would collide with routing or singleton providers', () => {
    for (const id of ['../company', 'company/one', 'Company', '', 'a'.repeat(65)]) {
      expect(() => parsePlatformLoginConfiguration({ ...company, id })).toThrow();
    }
    expect(() => parsePlatformLoginConfiguration({ ...google, id: 'company' })).toThrow(
      'fixed connection ID',
    );
    expect(() => parsePlatformLoginConfiguration({ ...company, id: 'github' })).toThrow('reserved');
  });

  it('rejects unsupported policy fields instead of silently pretending to enforce them', () => {
    expect(() =>
      parsePlatformLoginConfiguration({ ...company, allowedDomains: ['example.com'] }),
    ).toThrow('only supported by Google');
    expect(() =>
      parsePlatformLoginConfiguration({ ...google, requiredGroups: ['employees'] }),
    ).toThrow('Group restrictions');
    expect(() =>
      parsePlatformLoginConfiguration({ ...company, requiredGroups: ['employees', 'employees'] }),
    ).toThrow('duplicates');
  });

  it('pins the Access team and each protected origin to an audience', () => {
    for (const teamDomain of [
      'https://cloudflareaccess.com',
      'https://example.cloudflareaccess.com.evil.test',
      'https://example.cloudflareaccess.com/path',
      'https://example.cloudflareaccess.com:444',
    ]) {
      expect(() => parsePlatformAccessProtection({ ...protection, teamDomain })).toThrow();
    }
    expect(() => parsePlatformAccessProtection({ ...protection, applications: [] })).toThrow();
    expect(() =>
      parsePlatformAccessProtection({
        ...protection,
        applications: [...protection.applications, ...protection.applications],
      }),
    ).toThrow('exactly one');
  });

  it('does not allow company signup to become public by removing its gate', () => {
    const policy = parsePlatformAdmissionPolicy({ mode: 'company', access: true, connections: [] });
    expect(() => validatePlatformAdmissionPolicy(policy, [], null)).toThrow(
      'requires enabled protection',
    );
    expect(() =>
      validatePlatformAdmissionPolicy(policy, [], parsePlatformAccessProtection(protection)),
    ).not.toThrow();
    expect(() =>
      parsePlatformAdmissionPolicy({ mode: 'company', access: false, connections: [] }),
    ).toThrow();
  });

  it('requires explicit company connections and enforces their enabled state', () => {
    const policy = parsePlatformAdmissionPolicy({
      mode: 'company',
      access: false,
      connections: ['company'],
    });
    expect(() => validatePlatformAdmissionPolicy(policy, [], null)).toThrow('enabled connection');
    expect(() =>
      validatePlatformAdmissionPolicy(policy, [parsePlatformLoginConfiguration(company)], null),
    ).not.toThrow();
    const social = parsePlatformAdmissionPolicy({
      mode: 'company',
      access: false,
      connections: ['google'],
    });
    expect(() =>
      validatePlatformAdmissionPolicy(social, [parsePlatformLoginConfiguration(google)], null),
    ).toThrow('company membership');
    expect(() =>
      validatePlatformAdmissionPolicy(
        social,
        [parsePlatformLoginConfiguration({ ...google, allowedDomains: ['example.com'] })],
        null,
      ),
    ).not.toThrow();
  });

  it('matches stable signup identities exactly without treating them as email grants', () => {
    const entry = parsePlatformSignupAllowlistEntry({
      type: 'identity',
      connectionId: 'company',
      subject: 'Employee-42',
      note: 'No verified email',
    });
    const identity = {
      connectionId: 'company',
      subject: 'Employee-42',
      provider: 'oidc',
      login: 'employee@example.com',
      email: 'employee@example.com',
    };
    expect(isPlatformSignupAllowed(identity, [entry])).toBe(true);
    expect(isPlatformSignupAllowed({ ...identity, connectionId: 'another' }, [entry])).toBe(false);
    expect(isPlatformSignupAllowed({ ...identity, subject: 'employee-42' }, [entry])).toBe(false);
    expect(isPlatformSignupAllowed({ ...identity, subject: 'Employee-43' }, [entry])).toBe(false);
    expect(
      isPlatformSignupAllowed({ ...identity, subject: 'another', email: 'Employee-42' }, [entry]),
    ).toBe(false);
  });

  it('validates the public identity allowlist contract without folding subjects', () => {
    expect(
      parsePlatformSignupAllowlistEntry({
        type: 'identity',
        connectionId: 'company',
        subject: 'Case-Sensitive Subject',
      }),
    ).toEqual({
      type: 'identity',
      connectionId: 'company',
      subject: 'Case-Sensitive Subject',
    });
    expect(() =>
      parsePlatformSignupAllowlistEntry({
        type: 'identity',
        connectionId: 'missing/path',
        subject: 'employee',
      }),
    ).toThrow('connection IDs');
  });
});
