import { intro, outro, log, select, isCancel, cancel } from '@clack/prompts';
import { getToken, getTokenSource, removeToken, runLogin, saveToken, isStagingMode } from './auth';
import { isExpiredTokenError, PlatformClient } from './client';
import { cliTitle, createSpinner } from './output';

export async function promptForLoginToken(): Promise<string> {
  const provider = await select({
    message: 'Choose a login provider:',
    options: [
      { value: 'github', label: 'GitHub' },
      { value: 'google', label: 'Google' },
    ],
  });

  if (isCancel(provider)) {
    cancel('Login cancelled.');
    process.exit(0);
  }

  const providerName = provider === 'github' ? 'GitHub' : 'Google';
  const s = createSpinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const token = await runLogin(provider);
    saveToken(token);
    s.stop('Logged in!');
    return token;
  } catch (err) {
    s.stop('Login failed');
    throw err;
  }
}

export async function runLoginCommand(): Promise<void> {
  console.log();
  intro(cliTitle('login'));

  const existing = getToken();
  let expiredEnvToken = false;
  if (existing) {
    const tokenSource = getTokenSource();
    const client = new PlatformClient(existing);
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
        removeToken();
        log.warn('Stored auth token expired. Starting a new login.');
      }
    }
  }

  await promptForLoginToken();
  if (expiredEnvToken) {
    outro(
      `${isStagingMode() ? 'Staging token saved.' : 'Token saved.'} Unset \`VOID_TOKEN\` to use it.`,
    );
    return;
  }
  outro(isStagingMode() ? 'Staging token saved.' : 'Token saved.');
}
