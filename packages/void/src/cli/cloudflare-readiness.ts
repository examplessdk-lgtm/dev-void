import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractWorkersDevSubdomain, normalizeWorkersDevSubdomain } from '@void/deploy-cloudflare';
import { dirname, join } from 'pathslash';

const STATE_FILE = join('.void', 'cloudflare.json');

type CloudflareLocalState = {
  workersDevSubdomain?: unknown;
  workersDevSubdomains?: unknown;
};

/** Resolve the account subdomain without exposing Cloudflare credentials to project code. */
export function resolveCloudflareWorkersDevSubdomain(
  root: string,
  accountId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const configured = env.CLOUDFLARE_WORKERS_SUBDOMAIN;
  if (configured !== undefined && configured.trim().length > 0) {
    const normalized = normalizeWorkersDevSubdomain(configured);
    if (!normalized) {
      throw new Error(
        'deploy: CLOUDFLARE_WORKERS_SUBDOMAIN must be the account subdomain, for example "my-team" or "my-team.workers.dev".',
      );
    }
    return normalized;
  }

  const cached = subdomainsByAccount(readCloudflareLocalState(root))[accountId];
  return typeof cached === 'string' ? normalizeWorkersDevSubdomain(cached) : undefined;
}

/** Cache a Wrangler-reported account subdomain for later no-preview version probes. */
export function rememberCloudflareWorkersDevSubdomain(
  root: string,
  accountId: string,
  url: string,
): boolean {
  const workersDevSubdomain = extractWorkersDevSubdomain(url);
  if (!workersDevSubdomain) {
    return false;
  }
  const current = readCloudflareLocalState(root);
  const currentByAccount = subdomainsByAccount(current);
  if (currentByAccount[accountId] === workersDevSubdomain) {
    return false;
  }
  const { workersDevSubdomain: _legacy, ...state } = current;
  const filePath = join(root, STATE_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...state,
        workersDevSubdomains: { ...currentByAccount, [accountId]: workersDevSubdomain },
      },
      null,
      2,
    ) + '\n',
  );
  return true;
}

function subdomainsByAccount(state: CloudflareLocalState): Record<string, unknown> {
  const value = state.workersDevSubdomains;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCloudflareLocalState(root: string): CloudflareLocalState {
  const filePath = join(root, STATE_FILE);
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CloudflareLocalState)
      : {};
  } catch {
    return {};
  }
}
