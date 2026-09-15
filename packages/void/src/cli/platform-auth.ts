import {
  announceCloudflareLogin,
  cloudflareAuthEnvironment,
  createBundledCloudflareAuthRunner,
} from './cloudflare-auth.ts';

export type PlatformCloudflareCredential = Readonly<{
  source: 'environment' | 'oauth';
  token: string;
}>;

type WranglerAuthResult = Readonly<{
  status: number | null;
  stderr: string;
  stdout: string;
}>;

export type PlatformCloudflareAuthDependencies = Readonly<{
  interactive?: boolean;
  runWrangler?: (args: ReadonlyArray<string>, capture: boolean) => WranglerAuthResult;
}>;

export async function resolvePlatformCloudflareCredential(
  dependencies: PlatformCloudflareAuthDependencies = {},
): Promise<PlatformCloudflareCredential> {
  const environmentToken =
    process.env.CLOUDFLARE_API_TOKEN?.trim() || process.env.CF_API_TOKEN?.trim() || '';
  if (environmentToken) {
    return { source: 'environment', token: environmentToken };
  }

  const runWrangler = dependencies.runWrangler ?? defaultWranglerAuthRunner;
  if (!(dependencies.interactive ?? process.stdin.isTTY === true)) {
    throw new Error(
      'platform: Cloudflare authentication is required. Run `void cloudflare login` interactively, or set CLOUDFLARE_API_TOKEN in CI.',
    );
  }
  const keyring = runWrangler(['auth', 'keyring', 'enable'], true);
  if (keyring.status !== 0) {
    throw new Error(
      'platform: Could not enable secure Cloudflare credential storage. Refusing to use a plaintext OAuth credential.',
    );
  }
  const existing = readWranglerOAuthCredential(runWrangler);
  if (existing) {
    return existing;
  }

  announceCloudflareLogin();
  const login = runWrangler(['login', '--use-keyring'], true);
  if (login.status !== 0) {
    throw new Error('platform: Cloudflare browser login did not complete.');
  }
  const credential = readWranglerOAuthCredential(runWrangler);
  if (!credential) {
    throw new Error('platform: Cloudflare sign-in completed without a usable OAuth credential.');
  }
  return credential;
}

export function readWranglerOAuthCredential(
  runWrangler: (
    args: ReadonlyArray<string>,
    capture: boolean,
  ) => WranglerAuthResult = defaultWranglerAuthRunner,
): PlatformCloudflareCredential | null {
  const result = runWrangler(['auth', 'token', '--json'], true);
  if (result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { token?: unknown; type?: unknown };
    if (parsed.type !== 'oauth' || typeof parsed.token !== 'string' || !parsed.token.trim()) {
      return null;
    }
    return { source: 'oauth', token: parsed.token.trim() };
  } catch {
    return null;
  }
}

function defaultWranglerAuthRunner(
  args: ReadonlyArray<string>,
  capture: boolean,
): WranglerAuthResult {
  return createBundledCloudflareAuthRunner(process.cwd())(args, capture) as WranglerAuthResult;
}

export function wranglerAuthEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return cloudflareAuthEnvironment(source);
}
