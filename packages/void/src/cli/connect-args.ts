import { parseArgs } from 'node:util';

export type ConnectArgs = {
  url: string;
  platform: 'cloudflare' | 'void' | null;
  noLogin: boolean;
};

export function parseConnectArgs(args: Array<string>): ConnectArgs {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      platform: { type: 'string' },
      'no-login': { type: 'boolean' },
    },
  });
  if (positionals.length > 1) {
    throw new Error('connect: Expected at most one platform URL.');
  }
  const platform = values.platform ?? null;
  if (platform !== null && platform !== 'cloudflare' && platform !== 'void') {
    throw new Error('connect: --platform must be cloudflare or void.');
  }
  if (platform === 'cloudflare' && (positionals.length > 0 || values['no-login'])) {
    throw new Error('connect: A URL and --no-login are only supported for Void platforms.');
  }
  return { url: positionals[0] ?? '', platform, noLogin: values['no-login'] ?? false };
}
