import { existsSync, readFileSync } from 'node:fs';
import { log, isCancel, select } from '@clack/prompts';
import { parse, type ParseError } from 'jsonc-parser';
import { basename, join } from 'pathslash';
import {
  createBundledCloudflareAuthRunner,
  ensureCloudflareAuthentication,
  type CloudflareAccount,
} from './cloudflare-auth.ts';
import { writeProvisionedWranglerConfig } from './wrangler.ts';

export async function connectCloudflare(
  root: string,
  interactive: boolean = Boolean(process.stdin.isTTY),
): Promise<CloudflareAccount> {
  if (process.env.CLOUDFLARE_ENV || process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH) {
    throw new Error(
      'connect: Named Cloudflare environments and config overrides are not supported.',
    );
  }
  let config: Record<string, unknown> = {};
  for (const name of ['wrangler.jsonc', 'wrangler.json']) {
    const path = join(root, name);
    if (!existsSync(path)) {
      continue;
    }
    const errors: Array<ParseError> = [];
    const parsed = parse(readFileSync(path, 'utf8'), errors);
    if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`connect: Invalid ${name}. Fix it before connecting to Cloudflare.`);
    }
    config = parsed;
    break;
  }
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  const configuredAccount = typeof config.account_id === 'string' ? config.account_id : undefined;
  if (envAccount && configuredAccount && envAccount !== configuredAccount) {
    throw new Error(
      'connect: The environment account differs from account_id in the Cloudflare config.',
    );
  }
  const pinnedAccount = configuredAccount || envAccount;
  const compatibilityDate =
    typeof config.compatibility_date === 'string'
      ? config.compatibility_date
      : new Date().toISOString().slice(0, 10);
  const initialWrite = writeProvisionedWranglerConfig(root, { compatibilityDate });
  log.info(`${basename(initialWrite.configPath)} is ready for Cloudflare deployment`);
  const { accounts } = await ensureCloudflareAuthentication({
    interactive,
    requireAccounts: true,
    runWrangler: createBundledCloudflareAuthRunner(root),
    whoamiArgs: ['-c', initialWrite.configPath],
  });
  let account = accounts.find((entry) => entry.id === pinnedAccount);
  if (pinnedAccount && !account) {
    throw new Error(
      `connect: The signed-in Cloudflare session cannot access account ${pinnedAccount}.`,
    );
  }
  if (!account && accounts.length === 1) {
    account = accounts[0];
  }
  if (!account) {
    if (!interactive) {
      throw new Error(
        'connect: Multiple Cloudflare accounts are available. Set CLOUDFLARE_ACCOUNT_ID.',
      );
    }
    const id = await select({
      message: 'Choose a Cloudflare account:',
      initialValue: accounts[0]?.id,
      options: accounts.map((entry) => ({ value: entry.id, label: entry.name, hint: entry.id })),
    });
    if (isCancel(id)) {
      throw new Error('connect: Cloudflare account selection was cancelled.');
    }
    account = accounts.find((entry) => entry.id === id);
  }
  if (!account) {
    throw new Error('connect: No Cloudflare account was selected.');
  }
  writeProvisionedWranglerConfig(
    root,
    { accountId: account.id },
    { configPath: initialWrite.configPath },
  );
  log.success(`Configured Cloudflare account: ${account.name}`);
  return account;
}
