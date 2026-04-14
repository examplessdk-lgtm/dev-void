export const VOID_SOCIAL_AUTH_PROVIDERS = [
  'apple',
  'atlassian',
  'cognito',
  'discord',
  'dropbox',
  'facebook',
  'figma',
  'github',
  'gitlab',
  'google',
  'huggingface',
  'kakao',
  'kick',
  'line',
  'linear',
  'linkedin',
  'microsoft',
  'naver',
  'notion',
  'paybin',
  'paypal',
  'polar',
  'railway',
  'reddit',
  'roblox',
  'salesforce',
  'slack',
  'spotify',
  'tiktok',
  'twitch',
  'twitter',
  'vercel',
  'vk',
  'zoom',
] as const;

export const VOID_EMAIL_AUTH_PROVIDER = 'email';

export const VOID_AUTH_PROVIDERS: readonly [
  typeof VOID_EMAIL_AUTH_PROVIDER,
  ...typeof VOID_SOCIAL_AUTH_PROVIDERS,
] = [VOID_EMAIL_AUTH_PROVIDER, ...VOID_SOCIAL_AUTH_PROVIDERS] as const;

export type VoidSocialAuthProvider = (typeof VOID_SOCIAL_AUTH_PROVIDERS)[number];
export type VoidAuthProvider = (typeof VOID_AUTH_PROVIDERS)[number];

const VOID_SOCIAL_AUTH_PROVIDER_SET = new Set<string>(VOID_SOCIAL_AUTH_PROVIDERS);
const VOID_AUTH_PROVIDER_SET = new Set<string>(VOID_AUTH_PROVIDERS);

export function isVoidSocialAuthProvider(value: string): value is VoidSocialAuthProvider {
  return VOID_SOCIAL_AUTH_PROVIDER_SET.has(value);
}

export function isVoidAuthProvider(value: string): value is VoidAuthProvider {
  return VOID_AUTH_PROVIDER_SET.has(value);
}

export function getVoidAuthProviderEnvNames(provider: VoidSocialAuthProvider): {
  clientId: string;
  clientSecret: string;
  legacyClientId?: string;
  legacyClientSecret?: string;
} {
  const normalized = provider.toUpperCase().replaceAll('-', '_');
  const envNames = {
    clientId: `AUTH_${normalized}_CLIENT_ID`,
    clientSecret: `AUTH_${normalized}_CLIENT_SECRET`,
  };

  if (provider === 'github') {
    return {
      ...envNames,
      legacyClientId: 'GITHUB_OAUTH_ID',
      legacyClientSecret: 'GITHUB_OAUTH_SECRET',
    };
  }

  if (provider === 'google') {
    return {
      ...envNames,
      legacyClientId: 'GOOGLE_OAUTH_ID',
      legacyClientSecret: 'GOOGLE_OAUTH_SECRET',
    };
  }

  return envNames;
}
