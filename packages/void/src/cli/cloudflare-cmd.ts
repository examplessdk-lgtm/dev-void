import { log } from '@clack/prompts';
import type { CloudflareArgs } from './cloudflare-args.ts';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
  parseCloudflareAccounts,
} from './cloudflare-auth.ts';

export async function runCloudflareCommand(root: string, args: CloudflareArgs): Promise<void> {
  const runWrangler = createBundledCloudflareAuthRunner(root);
  switch (args.subcommand) {
    case 'login': {
      const session = await ensureCloudflareAuthentication({ runWrangler });
      log.success(formatAccounts('Signed in to Cloudflare.', session.accounts));
      return;
    }
    case 'status': {
      const result = await runWrangler(['whoami', '--json'], true);
      const accounts = result.status === 0 ? parseCloudflareAccounts(result.stdout) : null;
      if (!accounts) {
        throw new Error('Not signed in to Cloudflare. Run `void cloudflare login`.');
      }
      log.info(formatAccounts('Signed in to Cloudflare.', accounts));
      return;
    }
    case 'logout': {
      const keyring = await runWrangler(['auth', 'keyring', 'enable'], true);
      if (keyring.status !== 0) {
        throw new Error('Could not access secure Cloudflare credential storage.');
      }
      const result = await runWrangler(['logout'], true);
      if (result.status !== 0) {
        throw new Error('Could not remove the local Cloudflare browser session.');
      }
      if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) {
        log.warn(
          'Removed the local Cloudflare browser session. An API token is still set in this environment.',
        );
      } else {
        log.success('Signed out of Cloudflare.');
      }
      return;
    }
  }
}

function formatAccounts(
  heading: string,
  accounts: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (accounts.length === 0) {
    return `${heading} No accessible accounts were returned.`;
  }
  return [heading, ...accounts.map((account) => `  ${account.name} (${account.id})`)].join('\n');
}
