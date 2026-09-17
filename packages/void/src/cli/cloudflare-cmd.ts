import { log } from '@clack/prompts';
import { basename } from 'pathslash';
import type { CloudflareArgs } from './cloudflare-args.ts';
import {
  createBundledCloudflareAuthRunner,
  cloudflareCredentialOverrides,
  enableCloudflareKeyring,
  ensureCloudflareAuthentication,
  parseCloudflareAuthSession,
  type CloudflareAuthSession,
} from './cloudflare-auth.ts';
import { readRootWranglerConfig } from './wrangler.ts';

export async function runCloudflareCommand(root: string, args: CloudflareArgs): Promise<void> {
  const runWrangler = createBundledCloudflareAuthRunner(root);
  switch (args.subcommand) {
    case 'login': {
      const session = await ensureCloudflareAuthentication({ runWrangler, forceLogin: true });
      log.success(formatSession(root, session));
      return;
    }
    case 'status': {
      const result = await runWrangler(['whoami', '--json'], true);
      const session =
        result.status === 0 && !result.signal && !result.error
          ? parseCloudflareAuthSession(result.stdout)
          : null;
      if (!session) {
        throw new Error('Not signed in to Cloudflare. Run `void cloudflare login`.');
      }
      if (session.authType === 'OAuth Token') {
        await enableCloudflareKeyring(runWrangler);
      }
      log.info(formatSession(root, session));
      return;
    }
    case 'logout': {
      await enableCloudflareKeyring(runWrangler);
      const result = await runWrangler(['logout'], true);
      if (result.status !== 0) {
        throw new Error('Could not remove the local Cloudflare browser session.');
      }
      const overrides = cloudflareCredentialOverrides();
      if (overrides.length > 0) {
        log.warn(
          `Removed the local Cloudflare browser session. Environment credentials remain active: ${overrides.join(', ')}.`,
        );
      } else {
        log.success('Signed out of Cloudflare.');
      }
      return;
    }
  }
}

function formatSession(root: string, session: CloudflareAuthSession): string {
  const lines = ['Signed in to Cloudflare.'];
  if (session.email) {
    lines.push(`User: ${session.email}`);
  }
  if (session.authType) {
    lines.push(`Authentication: ${session.authType}`);
  }
  if (session.authType === 'OAuth Token') {
    lines.push('Credential storage: encrypted file protected by the OS keychain.');
  }
  const overrides = cloudflareCredentialOverrides();
  if (overrides.length > 0) {
    lines.push(`Environment credentials: ${overrides.join(', ')}`);
  }
  lines.push('Accessible accounts:');
  lines.push(
    ...(session.accounts.length > 0
      ? session.accounts.map((account) => `  ${account.name} (${account.id})`)
      : ['  No accessible accounts were returned.']),
  );

  try {
    const rootConfig = readRootWranglerConfig(root);
    const configured = rootConfig?.config.account_id;
    const environment = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
    const accountId = typeof configured === 'string' && configured ? configured : environment;
    if (accountId) {
      const source =
        accountId === configured
          ? basename(rootConfig!.configPath)
          : process.env.CLOUDFLARE_ACCOUNT_ID
            ? 'CLOUDFLARE_ACCOUNT_ID'
            : 'CF_ACCOUNT_ID';
      const account = session.accounts.find((account) => account.id === accountId);
      lines.push(
        `Deployment account: ${account ? `${account.name} (${accountId})` : accountId} (from ${source}).`,
      );
      if (!account) {
        lines.push(
          'The pinned deployment account was not returned by this authentication check. Signing in does not change the project target.',
        );
      }
      if (configured && environment && configured !== environment) {
        lines.push(
          'The environment account conflicts with the project configuration; resolve the mismatch before deploying.',
        );
      }
    } else {
      lines.push('Deployment account: not selected.');
    }
  } catch {
    lines.push(
      'Deployment account: unavailable because the Cloudflare configuration could not be read.',
    );
  }
  return lines.join('\n');
}
