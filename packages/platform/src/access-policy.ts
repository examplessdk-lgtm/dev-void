// Rule kinds whose non-empty value names a company identity source or an
// Access group built from such rules.
const COMPANY_IDENTITY_RULES = [
  'email_list',
  'gsuite',
  'github-organization',
  'saml',
  'okta',
  'azureAD',
  'auth_context',
  'group',
] as const;

// Identity provider types whose required settings name one company directory:
// an Entra ID tenant, a Centrify, Okta or OneLogin account, a Google Workspace
// domain or a PingOne environment. One-time PIN, passkeys and public logins
// such as GitHub, Google (consumer accounts), Facebook, LinkedIn and Yandex
// admit anyone with an email address or an account there. Generic OIDC and
// SAML connect any provider, including ones with public sign-up, such as
// consumer Google in Cloudflare's own OIDC example, so their type proves
// nothing about who can sign in.
const COMPANY_IDENTITY_PROVIDER_TYPES: ReadonlySet<unknown> = new Set([
  'azureAD',
  'centrify',
  'google-apps',
  'okta',
  'onelogin',
  'pingone',
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** An exact email domain, such as `example.com`, without wildcards or an `@`. */
export function isPlatformAccessEmailDomain(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(value);
}

/** Whether signing in with this Access identity provider proves a company identity. */
export function isPlatformAccessCompanyIdentityProvider(
  provider: Readonly<Record<string, unknown>>,
): boolean {
  if (provider.type === 'cloudflare') {
    // Without this setting, any Cloudflare user can sign in.
    return plainObject(provider.config) && provider.config.restrict_to_account_members === true;
  }
  return COMPANY_IDENTITY_PROVIDER_TYPES.has(provider.type);
}

/**
 * Whether one Access include or require rule restricts people to company
 * identities. The installer checks the policies that protect the platform and
 * the API checks project Zero Trust policies with this same rule list.
 *
 * A `login_method` rule admits everyone who can use the identity provider it
 * names, so it counts only when `companyLoginMethod` accepts that provider ID.
 */
export function isPlatformAccessIdentityRule(
  rule: Readonly<Record<string, unknown>>,
  companyLoginMethod: (identityProviderId: string) => boolean,
): boolean {
  if (rule.email_domain) {
    return plainObject(rule.email_domain) && isPlatformAccessEmailDomain(rule.email_domain.domain);
  }
  if (rule.email) {
    return (
      plainObject(rule.email) &&
      typeof rule.email.email === 'string' &&
      /^[^\s*@]+@[^\s*@]+\.[^\s*@]+$/.test(rule.email.email)
    );
  }
  if (rule.login_method) {
    return (
      plainObject(rule.login_method) &&
      typeof rule.login_method.id === 'string' &&
      companyLoginMethod(rule.login_method.id)
    );
  }
  return COMPANY_IDENTITY_RULES.some((key) => {
    const value = Object.hasOwn(rule, key) ? rule[key] : undefined;
    return plainObject(value) && Object.keys(value).length > 0;
  });
}
