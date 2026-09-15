import type { SubcommandDef } from './subcommand-prompt.ts';

export const cloudflareSubcommands: Array<SubcommandDef> = [
  { name: 'login', description: 'Sign in to Cloudflare securely' },
  { name: 'status', description: 'Show Cloudflare authentication and accounts' },
  { name: 'logout', description: 'Remove the local Cloudflare browser session' },
];

export type CloudflareArgs = { subcommand: 'login' | 'status' | 'logout' };

export function parseCloudflareArgs(args: Array<string>): CloudflareArgs {
  const [subcommand, extra] = args;
  if (!subcommand || !['login', 'status', 'logout'].includes(subcommand)) {
    throw new Error('cloudflare: Usage: void cloudflare <login|status|logout>.');
  }
  if (extra) {
    throw new Error(`cloudflare: Unexpected argument '${extra}'.`);
  }
  return { subcommand: subcommand as CloudflareArgs['subcommand'] };
}
