import { execSync } from 'node:child_process';
import { log } from '@clack/prompts';
import { getToken, removeToken } from './auth';
import type { AuthArgs } from './auth-args';
import { PlatformClient } from './client';
import { runLoginCommand } from './login';

export async function runAuthCommand(root: string, args: AuthArgs): Promise<void> {
  switch (args.subcommand) {
    case 'login':
      return runLoginCommand(root);
    case 'logout':
      if (removeToken(root)) {
        log.success('Logged out.');
      } else {
        log.info('Not logged in.');
      }
      return;
    case 'whoami': {
      const token = getToken(root);
      if (!token) {
        log.error('Not logged in. Run `void auth login` first.');
        process.exit(1);
      }
      const client = new PlatformClient(token, { root });
      const user = await client.whoami();
      log.info(`${user.login} (${user.plan})`);
      return;
    }
    case 'token': {
      if (!getToken(root)) {
        await runLoginCommand(root);
      }
      const token = getToken(root);
      if (!token) {
        log.error('Login failed. Run `void auth login` to try again.');
        process.exit(1);
      }
      const platform = process.platform;
      const cmd =
        platform === 'darwin'
          ? 'pbcopy'
          : platform === 'win32'
            ? 'clip'
            : 'xclip -selection clipboard';
      try {
        execSync(cmd, { input: token });
        log.success('Token copied to clipboard.');
      } catch {
        log.warn('Could not copy to clipboard. Re-run `void login` to generate a new token.');
      }
      return;
    }
  }
}
