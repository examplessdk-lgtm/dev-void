import { getCloudflareAuthUseKeyringFromEnv } from '@cloudflare/workers-auth';
import {
  createCfAuth,
  createCfProfileStore,
  readUserPreferences,
  setKeyringPreference,
} from '@cloudflare/workers-auth/cf';

const logger = {
  debug() {},
  info() {},
  log() {},
  warn() {},
  error() {},
};

function session(root: string) {
  const auth = createCfAuth({
    logger,
    userAgent: 'void',
    prompt: async () => {
      throw new Error('Cloudflare session reads cannot prompt.');
    },
    select: async () => {
      throw new Error('Cloudflare session reads cannot prompt.');
    },
    isNoDefaultValueProvidedError: () => false,
  });
  auth.setProfile(createCfProfileStore({ logger }).resolve({ cwd: root }));
  return auth;
}

/** Borrow only the profile just verified by cf, including its encrypted store. */
export function readCfSessionCredential(
  root: string,
  identity: Record<string, unknown>,
): string | null {
  if (identity.authenticated !== true || identity.tokenValid !== true) {
    return null;
  }
  const auth = session(root);
  if (identity.authSource !== `OAuth token from ${auth.getCredentialStore().path()}`) {
    return null;
  }
  const token = auth.readAuthCredentials()?.oauth_token;
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  persistCfKeyringPreference(root);
  return token;
}

/** Keep subsequent cf logins on the encrypted profile adopted by Void. */
export function persistCfKeyringPreference(root: string): void {
  if (
    getCloudflareAuthUseKeyringFromEnv() === false ||
    readUserPreferences().keyring_enabled === true
  ) {
    return;
  }
  const auth = session(root);
  if (
    !setKeyringPreference(true, { logger, getCredentialStore: auth.getCredentialStore }).enabled
  ) {
    throw new Error('Cloudflare encrypted credential storage is unavailable.');
  }
}
