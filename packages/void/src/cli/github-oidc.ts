/**
 * GitHub Actions OIDC → Void deploy-token exchange.
 *
 * When `void deploy` runs inside GitHub Actions with no explicit `VOID_TOKEN`,
 * the CLI mints a short-lived GitHub OIDC token (audience `void`) and exchanges
 * it at `POST $VOID_API_URL/auth/github-oidc` for a short-lived, project-scoped
 * Void deploy token. Doing the exchange in-process lets the scaffolded workflow
 * collapse to a single `void deploy` step — no curl/jq token-exchange step.
 *
 * Server contract (platform `POST /auth/github-oidc` handler):
 *   request  { oidcToken: string, project: string }   (project = slug)
 *   response { token: string, projectId, buildId }
 */

import { cfAccessHeaders } from '../shared/cf-access.ts';
import { ensureCloudflaredToken } from './cf-access.ts';

const OIDC_AUDIENCE = 'void';

/**
 * True when the process is running inside GitHub Actions with the OIDC token
 * request endpoint available — i.e. the workflow granted
 * `permissions: id-token: write`, so GitHub injected the request URL + token.
 */
export function isGithubActionsOidcAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.GITHUB_ACTIONS === 'true' &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0 &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0
  );
}

/**
 * Mint a GitHub Actions OIDC token (audience `void`) and exchange it for a
 * short-lived, project-scoped Void deploy token.
 *
 * Two hops:
 *   1. GET  $ACTIONS_ID_TOKEN_REQUEST_URL&audience=void  (Bearer request token)
 *        → `.value` is the OIDC JWT.
 *   2. POST $apiUrl/auth/github-oidc  { oidcToken, project }
 *        → `.token` is the Void deploy token.
 *
 * Throws a clear, actionable error (including the HTTP status and server error
 * body when available) on any non-OK response or missing field.
 */
export async function exchangeGithubOidcForDeployToken(
  apiUrl: string,
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      'github-oidc: GitHub Actions OIDC is unavailable (missing ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN). Ensure the workflow grants `permissions: id-token: write`.',
    );
  }

  const oidcToken = await requestGithubOidcToken(requestUrl, requestToken);
  return exchangeOidcTokenAtApi(apiUrl, project, oidcToken);
}

/**
 * GET the GitHub Actions OIDC token for audience `void`. GitHub's request URL
 * already carries a query string, so `audience` is appended alongside it.
 */
async function requestGithubOidcToken(requestUrl: string, requestToken: string): Promise<string> {
  const url = new URL(requestUrl);
  url.searchParams.set('audience', OIDC_AUDIENCE);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
  } catch (err) {
    throw new Error(`github-oidc: Failed to reach the GitHub OIDC token endpoint: ${errText(err)}`);
  }

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `github-oidc: Failed to mint a GitHub OIDC token (${res.status})${body ? `: ${body}` : ''}.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('github-oidc: GitHub OIDC token endpoint returned an invalid response.');
  }

  const value = (body as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('github-oidc: GitHub OIDC token endpoint did not return a token value.');
  }

  return value;
}

/** POST the OIDC JWT to the Void API and return the minted deploy token. */
async function exchangeOidcTokenAtApi(
  apiUrl: string,
  project: string,
  oidcToken: string,
): Promise<string> {
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  const url = `${base}/auth/github-oidc`;

  // This POST hits the Void API (which may be the Access-gated staging host)
  // before any PlatformClient exists, so it must carry CF Access credentials
  // itself — exactly like every other CLI → Void-API call (PlatformClient
  // ctor, exchangeLoginCode). `ensureCloudflaredToken` no-ops for prod/ungated
  // hosts and when the service-token pair or CF_ACCESS_TOKEN is already set;
  // `cfAccessHeaders` returns {} when no CF Access env is present (prod path).
  ensureCloudflaredToken(apiUrl);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfAccessHeaders(process.env) },
      body: JSON.stringify({ oidcToken, project }),
    });
  } catch (err) {
    throw new Error(`github-oidc: Failed to reach ${url}: ${errText(err)}`);
  }

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(
      `github-oidc: OIDC token exchange failed (${res.status})${body ? `: ${body}` : ''}. Confirm the repository is connected to project "${project}" with the github_actions executor.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('github-oidc: OIDC token exchange returned an invalid response.');
  }

  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('github-oidc: OIDC token exchange did not return a deploy token.');
  }

  return token;
}

/**
 * Emit a GitHub Actions `::add-mask::` workflow command so `value` is redacted
 * from workflow logs. No-op when not running inside GitHub Actions. GitHub reads
 * workflow commands from stdout.
 */
export function maskGithubActionsSecret(value: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS !== 'true' || !value) {
    return;
  }
  process.stdout.write(`::add-mask::${value}\n`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).trim();
  } catch {
    return '';
  }
}
