import { intro, outro, log, select, isCancel, cancel } from '@clack/prompts';
import {
  getToken,
  getTokenSource,
  removeToken,
  runLogin,
  runPlatformLogin,
  savePlatformToken,
  saveToken,
  isStagingMode,
} from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { cliTitle, createSpinner, pc } from './output.ts';

export async function promptForLoginToken(
  root: string = process.cwd(),
  platform?: { apiUrl: string; authenticationProviders: ReadonlyArray<'github' | 'google'> },
): Promise<string> {
  const providers = platform?.authenticationProviders ?? ['github', 'google'];
  if (providers.length === 0) {
    throw new Error('auth: This platform has no login providers.');
  }
  const provider =
    providers.length === 1
      ? providers[0]!
      : await select({
          message: 'Choose a login provider:',
          options: providers.map((value) => ({
            value,
            label: value === 'github' ? 'GitHub' : 'Google',
          })),
        });

  if (isCancel(provider) || typeof provider === 'symbol') {
    cancel('Login cancelled.');
    process.exit(0);
  }

  const providerName = provider === 'github' ? 'GitHub' : 'Google';
  const s = createSpinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const onUrl = (url: string) => {
      s.message(
        `Waiting for ${providerName} login. If your browser didn't open, visit:\n${pc.cyan(url)}`,
      );
    };
    const token = platform
      ? await runPlatformLogin(platform.apiUrl, provider, onUrl)
      : await runLogin(root, provider, onUrl);
    if (platform) {
      savePlatformToken(token, platform.apiUrl);
    } else {
      saveToken(token, root);
    }
    s.stop('Logged in!');
    return token;
  } catch (err) {
    s.stop('Login failed');
    throw err;
  }
}

export async function runLoginCommand(root: string = process.cwd()): Promise<void> {
  console.log();
  intro(cliTitle('login'));

  const existing = getToken(root);
  let expiredEnvToken = false;
  if (existing) {
    const tokenSource = getTokenSource();
    const client = new PlatformClient(existing, { root });
    try {
      await client.whoami();
      if (tokenSource === 'ci') {
        log.warn('Already authenticated via `VOID_TOKEN`.');
        outro('Unset `VOID_TOKEN` to log in with a different account.');
        return;
      }
      log.warn('Already logged in.');
      outro('To re-login, run `void auth logout` first.');
      return;
    } catch (error) {
      if (!isExpiredTokenError(error)) {
        throw error;
      }

      if (tokenSource === 'ci') {
        expiredEnvToken = true;
        log.warn('`VOID_TOKEN` is invalid or expired. Continuing with a new login.');
      } else {
        removeToken(root);
        log.warn('Stored auth token expired. Starting a new login.');
      }
    }
  }

  await promptForLoginToken(root);
  if (expiredEnvToken) {
    outro(
      `${isStagingMode(root) ? 'Staging token saved.' : 'Token saved.'} Unset \`VOID_TOKEN\` to use it.`,
    );
    return;
  }
  outro(isStagingMode(root) ? 'Staging token saved.' : 'Token saved.');
}
