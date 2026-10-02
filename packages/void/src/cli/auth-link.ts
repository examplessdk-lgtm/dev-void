import { execFile } from 'node:child_process';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { getApiUrl, getToken, openBrowser, runPlatformLogin, savePlatformToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import { selectPlatformLoginMethod } from './login.ts';
import { discoverPlatform } from './platform-cmd.ts';

export async function runAuthLink(root: string, connectionId?: string): Promise<void> {
  const token = getToken(root);
  if (!token) {
    throw new Error('auth: Sign in to your existing account with `void account login` first.');
  }
  const apiUrl = getApiUrl(root);
  const platform = await discoverPlatform(apiUrl);
  if (!platform.authentication) {
    throw new Error('auth: This platform must be upgraded before linking login methods.');
  }
  const target = await selectPlatformLoginMethod(platform, connectionId);
  const existing = await new PlatformClient(token, apiUrl).whoami();
  log.info(`Sign in again to ${existing.login} using an already linked login method.`);
  const source = await selectPlatformLoginMethod(platform);
  const freshToken = await runPlatformLogin(apiUrl, source.id, (url) =>
    log.info(`Sign in: ${url}`),
  );
  const client = new PlatformClient(freshToken, apiUrl);
  const fresh = await client.whoami();
  if (fresh.id !== existing.id) {
    throw new Error(
      'auth: You signed in to a different Void account. Start again with a login method already linked to your original account.',
    );
  }
  savePlatformToken(freshToken, apiUrl);
  const launch = await client.startIdentityLink(target.id);
  log.info(
    `Authenticate with ${target.label}, then review and confirm the identity in your browser.\n${launch.url}`,
  );
  openBrowser(launch.url, execFile);
}
