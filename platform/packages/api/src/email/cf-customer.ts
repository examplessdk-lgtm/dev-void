/**
 * Customer-Cloudflare API client — the calls the api makes INTO the
 * customer's own Cloudflare account/zone with the credential they granted
 * (an OAuth grant's refreshed access token, or a pasted API token on the
 * fallback path). Design doc 0078, "Custom domains on Cloudflare".
 *
 * Follows cfFetch (../provisioning/cloudflare-api.ts): Bearer auth, the v4
 * `{ success, errors, result }` envelope, and CloudflareApiError carrying
 * the HTTP status so callers branch on the wire code. Two deviations:
 *   - A FormData body (the relay script upload) must not carry a hand-set
 *     Content-Type — fetch fills in the multipart boundary, same handling
 *     as the WfP upload in routes/deploy.ts.
 *   - relayScriptExists reads the raw script GET, which answers the worker
 *     source or a bare 404 — not a v4 envelope.
 *
 * The credential is only ever sent as the Authorization header. It is
 * never logged, embedded in an error message, or returned.
 */

import { CloudflareApiError } from '../provisioning/cloudflare-api.ts';
import {
  RELAY_EMAIL_DOMAIN_BINDING,
  RELAY_PROXY_ORIGIN_BINDING,
  RELAY_SECRET_BINDING,
} from './relay-worker.ts';

export const CF_CUSTOMER_API_BASE = 'https://api.cloudflare.com/client/v4';

// wrangler's public PKCE OAuth client (design doc 0078, "The OAuth grant
// on wrangler's client") — the refresh chain the api owns per domain row.
export const CF_EMAIL_OAUTH_CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const CF_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const CF_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';

type CfCustomerResult<T> = Readonly<{
  success: boolean;
  errors: ReadonlyArray<{ code: number; message: string }>;
  result: T;
}>;

/**
 * cfFetch with a customer credential. Same envelope handling and typed
 * error; the only addition is the FormData Content-Type carve-out above.
 */
export async function cfCustomerFetch<T>(
  url: string,
  credential: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const json = (await response.json()) as CfCustomerResult<T>;
  if (!json.success) {
    const message = json.errors.map((error) => error.message).join(', ');
    throw new CloudflareApiError(`Cloudflare API error: ${message}`, response.status);
  }
  return json.result;
}

export type CfTokenVerification = Readonly<{
  id: string;
  status: string;
  expires_on?: string | null;
}>;

export type CfCustomerZone = Readonly<{
  id: string;
  name: string;
  account: Readonly<{ id: string }>;
}>;

export type RelayScriptUpload = Readonly<{
  /** Module-syntax worker source (RELAY_SOURCE). */
  source: string;
  compatibilityDate: string;
  /** Declared as the VOID_PROXY_ORIGIN plain-text var. */
  proxyOrigin: string;
  /** Declared as the VOID_EMAIL_DOMAIN plain-text var. */
  emailDomain: string;
}>;

export type SendRawMessage = Readonly<{
  from: string;
  recipients: ReadonlyArray<string>;
  mime_message: string;
}>;

export type SendRawResult = Readonly<{
  message_id?: string;
}>;

export type CfCatchAllRule = Readonly<{
  enabled: boolean;
  /** The worker name a 'worker' action points at; null for any other action shape. */
  workerName: string | null;
}>;

/** One entry of the sending-subdomain list; name + enabled are required on the wire. */
export type CfSendingSubdomain = Readonly<{
  name: string;
  enabled: boolean;
}>;

export type CfCustomerClient = Readonly<{
  /** GET /user/tokens/verify — the api_token verify step. */
  verifyToken: () => Promise<CfTokenVerification>;
  /** GET /zones?name= — exact-name match, or null when the credential can't see it. */
  findZone: (name: string) => Promise<CfCustomerZone | null>;
  /**
   * POST /zones/{z}/email/routing/dns. Empty body enables the apex;
   * { name } enables a subdomain (terraform-provider-cloudflare#5890's
   * Support quote; only the GET's `subdomain` query param is deprecated).
   */
  enableRouting: (zoneId: string, name?: string) => Promise<void>;
  /** POST /zones/{z}/email/sending/subdomains — the call wrangler's `email sending enable` makes. */
  onboardSending: (zoneId: string, name: string) => Promise<void>;
  /**
   * GET /zones/{z}/email/sending/subdomains — the onboard_sending
   * idempotency read-back for setup re-runs. Parsed down to name +
   * enabled (both required on the wire); malformed entries are dropped.
   */
  listSendingSubdomains: (zoneId: string) => Promise<ReadonlyArray<CfSendingSubdomain>>;
  /** Raw script GET — true when the name is taken in this account, false on 404. */
  relayScriptExists: (accountId: string, scriptName: string) => Promise<boolean>;
  /**
   * PUT /accounts/{a}/workers/scripts/{name} as multipart FormData:
   * a metadata part (main_module + compatibility_date + the two plain-text
   * vars) and one module part — the WfP upload shape from routes/deploy.ts
   * minus the dispatch namespace.
   */
  putRelayScript: (
    accountId: string,
    scriptName: string,
    upload: RelayScriptUpload,
  ) => Promise<void>;
  /** PUT .../secrets — the non-namespace variant of putWorkerSecret (project-secrets.ts). */
  putRelaySecret: (accountId: string, scriptName: string, secret: string) => Promise<void>;
  /** PUT catch-all pointing the zone at the relay. `value` is a one-entry array, one action only. */
  setCatchAll: (zoneId: string, relayWorkerName: string) => Promise<void>;
  /**
   * GET catch-all — the ownership read before any write. The catch-all is
   * zone-scoped with no domain parameter, so one PUT can hijack another
   * domain's (or another tool's) inbound; callers must read first and only
   * write what they own. 404 → null.
   */
  getCatchAll: (zoneId: string) => Promise<CfCatchAllRule | null>;
  /** PUT catch-all with wrangler's reset shape: one drop action, disabled. */
  resetCatchAll: (zoneId: string) => Promise<void>;
  /**
   * GET /zones/{z}/email/routing — raw result. The subdomain-readiness
   * fields are probe-pinned (probe 8), so callers parse defensively.
   */
  getRoutingSettings: (zoneId: string) => Promise<unknown>;
  /** DELETE the relay script. 404 is success — the customer may have deleted it themselves. */
  deleteRelayScript: (accountId: string, scriptName: string) => Promise<void>;
  /** POST /accounts/{a}/email/sending/send_raw — the REST send (contract 5). */
  sendRaw: (accountId: string, message: SendRawMessage) => Promise<SendRawResult>;
}>;

export function createCfCustomerClient(credential: string): CfCustomerClient {
  const call = <T>(path: string, init?: RequestInit): Promise<T> =>
    cfCustomerFetch<T>(`${CF_CUSTOMER_API_BASE}${path}`, credential, init);

  return {
    verifyToken: () => call<CfTokenVerification>('/user/tokens/verify'),

    findZone: async (name) => {
      const zones = await call<ReadonlyArray<CfCustomerZone>>(
        `/zones?name=${encodeURIComponent(name)}`,
      );
      return zones.find((zone) => zone.name.toLowerCase() === name.toLowerCase()) ?? null;
    },

    enableRouting: async (zoneId, name) => {
      await call(`/zones/${zoneId}/email/routing/dns`, {
        method: 'POST',
        ...(name === undefined ? {} : { body: JSON.stringify({ name }) }),
      });
    },

    onboardSending: async (zoneId, name) => {
      await call(`/zones/${zoneId}/email/sending/subdomains`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    },

    listSendingSubdomains: async (zoneId) => {
      // The list paginates (CF v4 default page size 20): an onboarded
      // domain past the first page must still confirm the read-back. The
      // envelope's result_info is discarded by cfCustomerFetch, so a short
      // page is the last page; the page cap is defensive, never hit in
      // practice.
      const parsed: Array<CfSendingSubdomain> = [];
      for (let page = 1; page <= 20; page++) {
        const rows = await call<unknown>(
          `/zones/${zoneId}/email/sending/subdomains?page=${page}&per_page=50`,
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          break;
        }
        for (const row of rows) {
          if (
            row &&
            typeof row === 'object' &&
            typeof (row as { name?: unknown }).name === 'string'
          ) {
            parsed.push({
              name: (row as { name: string }).name,
              enabled: (row as { enabled?: unknown }).enabled === true,
            });
          }
        }
        if (rows.length < 50) {
          break;
        }
      }
      return parsed;
    },

    relayScriptExists: async (accountId, scriptName) => {
      const response = await fetch(
        `${CF_CUSTOMER_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`,
        { headers: { Authorization: `Bearer ${credential}` } },
      );
      if (response.status === 404) {
        return false;
      }
      if (!response.ok) {
        throw new CloudflareApiError(
          `Cloudflare API error: script lookup failed with HTTP ${response.status}`,
          response.status,
        );
      }
      // The answer is the worker's source — the customer's code. Only
      // existence matters; never read it into memory.
      await response.body?.cancel();
      return true;
    },

    putRelayScript: async (accountId, scriptName, upload) => {
      const metadata = {
        main_module: 'index.js',
        compatibility_date: upload.compatibilityDate,
        bindings: [
          { type: 'plain_text', name: RELAY_PROXY_ORIGIN_BINDING, text: upload.proxyOrigin },
          { type: 'plain_text', name: RELAY_EMAIL_DOMAIN_BINDING, text: upload.emailDomain },
        ],
      };
      const formData = new FormData();
      formData.append(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      );
      formData.append(
        'index.js',
        new Blob([upload.source], { type: 'application/javascript+module' }),
        'index.js',
      );
      await call(`/accounts/${accountId}/workers/scripts/${scriptName}`, {
        method: 'PUT',
        body: formData,
      });
    },

    putRelaySecret: async (accountId, scriptName, secret) => {
      await call(`/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
        method: 'PUT',
        body: JSON.stringify({ name: RELAY_SECRET_BINDING, text: secret, type: 'secret_text' }),
      });
    },

    setCatchAll: async (zoneId, relayWorkerName) => {
      await call(`/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: 'PUT',
        body: JSON.stringify({
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: [relayWorkerName] }],
          enabled: true,
        }),
      });
    },

    getCatchAll: async (zoneId) => {
      let rule: unknown;
      try {
        rule = await call<unknown>(`/zones/${zoneId}/email/routing/rules/catch_all`);
      } catch (err) {
        if (err instanceof CloudflareApiError && err.status === 404) {
          return null;
        }
        throw err;
      }
      // cfCustomerFetch already unwrapped the envelope's `result`.
      if (!rule || typeof rule !== 'object') {
        return null;
      }
      const actions = (rule as { actions?: unknown }).actions;
      const first = Array.isArray(actions) && actions.length > 0 ? actions[0] : null;
      const workerName =
        first !== null &&
        typeof first === 'object' &&
        (first as { type?: unknown }).type === 'worker' &&
        Array.isArray((first as { value?: unknown }).value)
          ? (((first as { value: Array<unknown> }).value[0] as string | undefined) ?? null)
          : null;
      return { enabled: (rule as { enabled?: unknown }).enabled === true, workerName };
    },

    resetCatchAll: async (zoneId) => {
      await call(`/zones/${zoneId}/email/routing/rules/catch_all`, {
        method: 'PUT',
        body: JSON.stringify({
          matchers: [{ type: 'all' }],
          actions: [{ type: 'drop' }],
          enabled: false,
        }),
      });
    },

    // cfCustomerFetch already unwraps the envelope's `result`.
    getRoutingSettings: (zoneId) => call<unknown>(`/zones/${zoneId}/email/routing`),

    deleteRelayScript: async (accountId, scriptName) => {
      try {
        await call(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof CloudflareApiError && err.status === 404) {
          return;
        }
        throw err;
      }
    },

    sendRaw: (accountId, message) =>
      call<SendRawResult>(`/accounts/${accountId}/email/sending/send_raw`, {
        method: 'POST',
        body: JSON.stringify(message),
      }),
  };
}

/**
 * OAuth token-endpoint failure. `code` is the RFC 6749 error string
 * ('invalid_grant' & co) — the only piece callers branch on. The message
 * deliberately carries just the code and HTTP status: never the
 * description, never any token material.
 */
export class OAuthGrantError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`Cloudflare OAuth grant failed: ${code} (HTTP ${status})`);
    this.name = 'OAuthGrantError';
    this.code = code;
    this.status = status;
  }
}

export type OauthGrantTokens = Readonly<{
  accessToken: string;
  /** The ROTATED refresh token — single-use, so persist it atomically with the lease. */
  refreshToken: string;
  expiresIn?: number;
}>;

/**
 * One round of the OAuth refresh chain on wrangler's public client
 * (contract 4): form-encoded POST to dash.cloudflare.com/oauth2/token.
 * Refresh tokens rotate on every use; a missing replacement in the answer
 * fails loudly rather than silently persisting a now-dead token.
 */
export async function refreshOauthGrant(refreshToken: string): Promise<OauthGrantTokens> {
  const response = await fetch(CF_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CF_EMAIL_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  let json: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null = null;
  try {
    json = await response.json();
  } catch {
    // Non-JSON error body (an HTML error page, a truncated response) —
    // classified below as unknown_error with the HTTP status.
  }
  if (!response.ok) {
    throw new OAuthGrantError(json?.error ?? 'unknown_error', response.status);
  }
  if (!json?.access_token || !json.refresh_token) {
    throw new OAuthGrantError('invalid_response', response.status);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    ...(json.expires_in === undefined ? {} : { expiresIn: json.expires_in }),
  };
}

/**
 * RFC 7009 revocation of the grant's refresh token on wrangler's public
 * client — the logout half of contract 4, mirroring wrangler's
 * `workers-auth` logout byte-for-byte: form-encoded POST carrying
 * client_id + token_type_hint + token, and NO Authorization header (a
 * public client authenticates with the token itself).
 *
 * THROWS on a network failure or a non-2xx status: CF answers 200 whether
 * the token was live or already dead (probed 2026-09-17), so a failure
 * leaves the grant's state genuinely unknown — and `removeEmailDomain`
 * records `revoke_grant` in failed_steps only when its dep throws. The
 * response body is ignored. The token is never logged or interpolated
 * into anything.
 */
export async function revokeOauthGrant(refreshToken: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(CF_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CF_EMAIL_OAUTH_CLIENT_ID,
        token_type_hint: 'refresh_token',
        token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    // Network-level failure. A fetch TypeError carries no request body, so
    // the token cannot leak through it.
    console.error('Cloudflare OAuth grant revocation request failed', err);
    throw err;
  }
  if (!response.ok) {
    console.error(`Cloudflare OAuth grant revocation failed with HTTP ${response.status}`);
    throw new Error(`Cloudflare OAuth grant revocation failed with HTTP ${response.status}`);
  }
}
