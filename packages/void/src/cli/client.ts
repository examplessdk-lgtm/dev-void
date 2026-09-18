import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { getPackageDir } from './agents.ts';
import { getApiUrl } from './auth.ts';
import { ensureCloudflaredToken } from './cf-access.ts';
import type { CliLogger } from './log-file.ts';
import { normalizePlatformApiUrl } from './platform-registry.ts';
import type { DeployAssetUploadRequest, DeployEvent, DeployUploadPayload } from './types.ts';

/**
 * Current CLI version. Sent as `X-Void-CLI-Version` on every platform
 * request so the platform's CLI-version gate can refuse stale CLIs
 * cleanly (HTTP 426 + `cli_outdated`) instead of letting a wire
 * mismatch surface as an opaque parse error.
 *
 * Resolved once per process. Returns `null` when package.json can't be
 * read or has no `version` string — the ctor then OMITS the header
 * entirely. We deliberately do NOT send a placeholder string like
 * "unknown": the platform treats present-but-unparseable headers as a
 * stale-CLI signal and would 426 the request, bricking the CLI on any
 * packaging error. Missing-header is the documented pass-through path.
 */
export function readCliVersion(): string | null {
  try {
    const pkgPath = join(getPackageDir(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

const VOID_CLI_VERSION = readCliVersion();

export type PlatformErrorPayload = {
  error?: string;
  message?: string;
  deployment?: string;
  minVersion?: string;
  clientVersion?: string;
};

export function parsePlatformErrorBody(body: string): PlatformErrorPayload | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as PlatformErrorPayload;
  } catch {
    return null;
  }
}

/**
 * Detects the `cli_outdated` 426 response shape emitted by the platform's
 * `cliVersionGate` middleware. When present, callers should surface the
 * server's `message` field verbatim — it already includes upgrade
 * instructions — rather than the default `<action>: <status> <body>`
 * which would dump raw JSON at the user.
 */
export function isCliOutdatedError(err: unknown): err is PlatformApiError {
  if (!(err instanceof PlatformApiError)) {
    return false;
  }
  if (err.status !== 426) {
    return false;
  }
  return parsePlatformErrorBody(err.body)?.error === 'cli_outdated';
}

export class PlatformApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code?: string;

  constructor(action: string, status: number, body: string) {
    const parsed = parsePlatformErrorBody(body);
    // cli_outdated: surface the server-supplied upgrade message verbatim
    // instead of the raw `<action>: <status> <body>` default. The message
    // already includes the `npm i -g void@latest` hint.
    const message =
      status === 426 && parsed?.error === 'cli_outdated' && parsed.message
        ? parsed.message
        : `${action}: ${status} ${body}`;
    super(message);
    this.name = 'PlatformApiError';
    this.status = status;
    this.body = body;
    this.code = parsed?.error ?? parsed?.message;
  }
}

async function throwPlatformApiError(action: string, res: Response): Promise<never> {
  throw new PlatformApiError(action, res.status, await res.text());
}

export function isExpiredTokenError(error: unknown): boolean {
  if (error instanceof PlatformApiError) {
    return error.status === 401 && error.code === 'invalid or expired token';
  }
  return false;
}

export type ProjectResponse = {
  url?: string;
  id: string;
  user_id: string;
  slug: string;
  type: string;
  created_at: string;
  custom_domain: string | null;
};

export type CreateProjectResponse = {
  url?: string;
  id: string;
  slug: string;
  /**
   * Present exactly when the platform scheduled the project owner's own
   * address to be registered as an outbound email destination. The
   * registration runs after the response is sent, so this says nothing about
   * its outcome — Cloudflare may mail a verification link, or adopt an
   * address the owner already verified. `void email destinations` shows the
   * resulting state.
   */
  owner_email_destination?: {
    address: string;
  };
};

export type DeleteProjectResponse = {
  ok: boolean;
  id: string;
  slug: string;
  warnings?: Array<string>;
};

export type DeploymentResponse = {
  id: string;
  status: string;
  source: string | null;
  commit: string | null;
  manifest: string | null;
  error_message: string | null;
  retained: boolean;
  applied_migrations: string | null;
  created_at: string;
  deployed_at: string | null;
};

export type DeploymentListResponse = {
  deployments: Array<DeploymentResponse>;
  activeDeploymentId: string | null;
};

export type SecretResponse = {
  ok: boolean;
  name: string;
};

export type LogEntry = {
  timestamp: number;
  outcome: string;
  logs: Array<{ level: string; message: Array<unknown>; timestamp: number }>;
  exceptions: Array<{ name: string; message: string; timestamp: number }>;
  url: string;
  method: string;
  status: string;
};

export type RequestEntry = {
  timestamp: string;
  type: string;
  method: string;
  status: string;
  bytes: number;
  durationMs: number;
};

export type BuildSummary = {
  id: string;
  status: string;
  executor: 'container' | 'github_actions';
  commit_sha: string | null;
  branch: string | null;
  exit_code: number | null;
  error: string | null;
  logs_url: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type BuildLogRow = {
  seq: number;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: number;
};

export type BuildLogsResponse = {
  lines: Array<BuildLogRow>;
  lastSeq: number;
  status: string;
  terminal: boolean;
  external: string | null;
};

export type EmailUsageResponse = {
  month: string;
  sent: number;
  received: number;
  limit: number;
  remaining: number;
  suspended: boolean;
};

export type EmailLogEntry = {
  timestamp: number;
  direction: 'sent' | 'received';
  from: string;
  to: string;
  subject?: string;
  status: string;
};

export type EmailLogsResponse = {
  logs: Array<EmailLogEntry>;
  pending?: boolean;
  note?: string;
};

export type EmailDestinationResponse = {
  id: string;
  address: string;
  status: 'pending' | 'verified' | 'failed';
  verified_at: string | null;
  created_at: string;
  /**
   * Set when the platform (not Cloudflare) mailed the confirmation link —
   * on the first add AND on every repeat add while the row is pending, since
   * a repeat POST is how that link gets re-sent.
   */
  platformVerificationPending?: boolean;
  /**
   * `false` when the call mailed nothing and the row waits on a Cloudflare
   * link sent EARLIER: a repeat add of a CF-pending address, or a first add
   * (201) of an address Cloudflare already held pending — the owner's own,
   * from another project or a hand add. CF refused the create and mails its
   * link on create only, so a bare 201 must not read as "a link went out".
   */
  verificationSent?: boolean;
};

export type DomainResponse = {
  id: string;
  project_id: string;
  hostname: string;
  cf_hostname_id: string;
  status: string;
  created_at: string;
  cname_target?: string;
  ownership_verification?: {
    type: 'txt';
    name: string;
    value: string;
  };
  ssl_validation_records?: Array<{
    txt_name?: string;
    txt_value?: string;
    status?: string;
  }>;
};

export type DomainStatusResponse = DomainResponse & {
  ssl_status: string;
  verification_errors?: Array<string>;
  cf_status?: string;
  awaiting_deployment?: boolean;
};

export type GithubInstallation = {
  id: string;
  installation_id: string;
  account_login: string;
  account_id: string;
  account_type: 'User' | 'Organization';
  repositories: Array<{ full_name: string; id: number }>;
  repository_selection: 'all' | 'selected';
  status: 'active' | 'suspended' | 'deleted';
  created_at: string;
  updated_at: string;
};

export type GithubConnection = {
  id: string;
  project_id: string;
  installation_id: string;
  repo_full_name: string;
  repository_id: string | null;
  branch: string;
  build_executor: 'container' | 'github_actions';
  workflow_path: string;
  requires_reconnect?: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * Asset declaration shape for `POST /:id/deploy/upload-urls`. Each entry
 * carries both hashes the platform needs:
 *   - `blake3` is the storage key (`assets/${projectId}/${blake3}`)
 *   - `md5` is the wire-level upload-integrity primitive — the platform
 *     bakes it into the presigned PUT URL as a SIGNED `Content-Md5`
 *     header so R2 enforces integrity at write time.
 */
export type UploadUrlAssetRequest = DeployAssetUploadRequest;

/**
 * Manifest-only (direct-to-R2) deploy payload. Sent as JSON to
 * `POST /:id/deploy` with `Content-Type: application/json`. Mirrors the
 * `handleManifestOnlyDeploy` server contract documented in design doc 0068.
 *
 * Asset bytes are NOT carried in this payload — they were uploaded directly
 * to R2 via presigned PUT URLs before this call. The server verifies each
 * declared asset key exists in R2 (parallel HEAD) before flipping routing.
 */
export type ManifestOnlyDeployPayload = DeployUploadPayload;

/**
 * Retry contract for the deploy POST's transport phase.
 *
 * - Only `fetch` rejections (`TypeError` — no HTTP response) are retried.
 *   A Response of any status means the server answered; surface it
 *   verbatim rather than replay a request it may have accepted.
 * - A rejected fetch does NOT prove the request never arrived — the
 *   connection may have dropped after delivery. Arbitration is left to
 *   the server's precheck, the only atomic (project-locked) verdict: if
 *   an earlier attempt or a concurrent deploy is still in flight, the
 *   replay is rejected with 409 and surfaced as a deploy conflict
 *   naming the deployment id. A client-side GET-then-decide lookup can
 *   never be authoritative (the row can transition between lookup and
 *   replay), so no dedupe query is made — the residual case is the lost
 *   attempt completing within seconds and being redeployed identically.
 */
const DEPLOY_POST_MAX_RETRIES = 3;
const DEPLOY_POST_BACKOFF_MS = [1000, 5000, 10000];

/**
 * HTTP client for the Void platform API.
 */
export class PlatformClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly cliLog?: CliLogger;
  readonly apiUrl: string;

  constructor(
    token: string,
    options?: string | { apiUrl?: string; root?: string; cliLog?: CliLogger },
  ) {
    if (typeof options === 'string') {
      this.baseUrl = normalizePlatformApiUrl(options);
    } else {
      this.baseUrl = normalizePlatformApiUrl(options?.apiUrl ?? getApiUrl(options?.root));
      this.cliLog = options?.cliLog;
    }
    this.apiUrl = this.baseUrl;
    ensureCloudflaredToken(this.baseUrl);
    this.authHeaders = {
      Authorization: `Bearer ${token}`,
      // Conditional spread: omit the header entirely if package.json was
      // unreadable. The platform's gate treats missing as pass-through;
      // sending a placeholder like "unknown" would trip the fail-closed
      // 426 path and brick the CLI permanently.
      ...(VOID_CLI_VERSION !== null && { 'X-Void-CLI-Version': VOID_CLI_VERSION }),
      ...cfAccessHeaders(process.env, this.baseUrl),
    };
  }

  async whoami(): Promise<{ login: string; plan: string }> {
    const res = await fetch(`${this.baseUrl}/me`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch user info', res);
    }

    return res.json();
  }

  async listProjects(): Promise<Array<ProjectResponse>> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list projects', res);
    }

    return res.json();
  }

  async listDeployments(projectId: string): Promise<DeploymentListResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/deployments`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list deployments', res);
    }

    return res.json();
  }

  async rollback(
    projectId: string,
    deploymentId: string,
    options?: { allowDestructive?: Array<string> },
  ): Promise<{
    ok: boolean;
    deploymentId?: string;
    migrationDiff?: Array<string>;
    error?: string;
  }> {
    const body: { deploymentId: string; allowDestructive?: Array<string> } = {
      deploymentId,
    };
    if (options?.allowDestructive && options.allowDestructive.length > 0) {
      body.allowDestructive = options.allowDestructive;
    }
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Rollback failed', res);
    }

    return res.json();
  }

  async cancelDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean; deploymentId: string; status: string }> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/deployments/${deploymentId}/cancel`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Cancel deployment failed', res);
    }

    return res.json();
  }

  async createProject(slug: string): Promise<CreateProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ slug }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to create project', res);
    }

    return res.json();
  }

  async preflight(
    projectId: string,
    assetManifest: Record<string, { hash: string; size: number }>,
    hasWorker?: boolean,
  ): Promise<{ needed: Array<string>; total: number; skipped: number }> {
    const total = Object.keys(assetManifest).length;
    try {
      const res = await fetch(`${this.baseUrl}/projects/${projectId}/deploy/preflight`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({ assetManifest, ...(hasWorker && { hasWorker }) }),
      });

      if (!res.ok) {
        const error = new PlatformApiError('Preflight failed', res.status, await res.text());
        if (isExpiredTokenError(error)) {
          throw error;
        }
        // Preflight not supported or error — fall back to uploading everything
        return { needed: Object.keys(assetManifest), total, skipped: 0 };
      }

      return res.json();
    } catch (error) {
      if (isExpiredTokenError(error)) {
        throw error;
      }
      // Network error — fall back to uploading everything
      return { needed: Object.keys(assetManifest), total, skipped: 0 };
    }
  }

  /**
   * Request presigned R2 PUT URLs for a batch of assets. Each entry carries
   * both `blake3` (storage key) and `md5` (wire-level integrity primitive)
   * so the platform can sign a PUT URL that R2 enforces against the bytes
   * the CLI is about to upload. See design doc 0068 for the full protocol.
   */
  async requestUploadUrls(
    projectId: string,
    assets: Array<UploadUrlAssetRequest>,
  ): Promise<Record<string, { url: string; headers: Record<string, string> }>> {
    const url = `${this.baseUrl}/projects/${projectId}/deploy/upload-urls`;
    this.cliLog?.info('upload_urls_post', { url, assetCount: assets.length });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ assets }),
    });

    const cfRay = res.headers.get('cf-ray');
    const cfCacheStatus = res.headers.get('cf-cache-status');
    this.cliLog?.info('upload_urls_response', {
      status: res.status,
      cfRay,
      cfCacheStatus,
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to request upload URLs', res);
    }

    const json = (await res.json()) as {
      urls: Record<string, { url: string; headers: Record<string, string> }>;
    };
    return json.urls;
  }

  /**
   * Manifest-only (direct-to-R2) deploy. POSTs a JSON body containing the
   * deploy manifest, asset manifest (no asset bytes), and any worker module
   * bytes (base64-encoded). Streams an NDJSON response that the caller can
   * apply with the existing `applyDeployEvent` machinery.
   */
  async *finalizeDeploy(
    projectId: string,
    payload: ManifestOnlyDeployPayload,
  ): AsyncGenerator<DeployEvent> {
    const url = `${this.baseUrl}/projects/${projectId}/deploy`;
    yield* this.streamDeployRequest(url, projectId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(payload),
    });
  }

  /**
   * POST + NDJSON-stream-reader used by `finalizeDeploy()`. Captures
   * `cf-ray` + `cf-cache-status` for postmortem correlation.
   */
  private async *streamDeployRequest(
    url: string,
    projectId: string,
    init: RequestInit,
  ): AsyncGenerator<DeployEvent> {
    const cliLog = this.cliLog;
    cliLog?.info('deploy_post', { url });

    // `fetch` reports transport failures as TypeError ('fetch failed') —
    // the only retryable case per the DEPLOY_POST_* contract above.
    // Anything else (e.g. AbortError) is not transient and fails fast.
    let res: Response;
    let attempt = 0;
    while (true) {
      try {
        res = await fetch(url, init);
        break;
      } catch (err) {
        if (!(err instanceof TypeError) || attempt >= DEPLOY_POST_MAX_RETRIES) {
          cliLog?.error('deploy_fetch_rejected', err, { url, attempts: attempt + 1 });
          throw err;
        }
        cliLog?.warn('deploy_fetch_retry', {
          url,
          attempt: attempt + 1,
          delayMs: DEPLOY_POST_BACKOFF_MS[attempt],
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(DEPLOY_POST_BACKOFF_MS[attempt]);
        attempt++;
      }
    }

    // `cf-ray` and `cf-cache-status` are the correlation keys that platform
    // engineers need to look up server-side tail logs. Capture them whenever
    // the response makes it back.
    const cfRay = res.headers.get('cf-ray');
    const cfCacheStatus = res.headers.get('cf-cache-status');
    cliLog?.info('deploy_response', {
      status: res.status,
      cfRay,
      cfCacheStatus,
      contentType: res.headers.get('content-type'),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 409) {
        // The precheck's authoritative verdict — a deployment is already
        // in flight (possibly the earlier attempt of this same deploy,
        // or a concurrent one). Surface it as a structured error event
        // naming the deployment rather than a bare HTTP failure.
        let parsed: { error?: string; deployment?: string } | null = null;
        try {
          parsed = JSON.parse(body) as typeof parsed;
        } catch {
          // Non-JSON 409 — fall through to the generic error below.
        }
        if (parsed?.deployment) {
          cliLog?.warn('deploy_conflict', {
            url,
            deploymentId: parsed.deployment,
            error: parsed.error,
          });
          yield {
            event: 'error',
            step: 'finalize',
            message:
              `${parsed.error ?? 'deploy in progress'}: deployment ${parsed.deployment} — ` +
              'it may be an earlier attempt of this deploy or a concurrent one; ' +
              'inspect with `void project status` before redeploying',
          };
          return;
        }
      }
      throw new PlatformApiError('Deploy failed', res.status, body);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytesRead = 0;
    let firstByteAt: number | null = null;
    const startedAt = Date.now();
    let eventCount = 0;
    let lastEventName = '<none>';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          cliLog?.info('deploy_stream_eof', {
            bytesRead,
            eventCount,
            lastEvent: lastEventName,
          });
          break;
        }
        if (firstByteAt === null) {
          firstByteAt = Date.now() - startedAt;
          cliLog?.info('deploy_stream_ttfb', { ttfbMs: firstByteAt });
        }
        bytesRead += value.byteLength;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.trim()) {
            const event = JSON.parse(line) as DeployEvent;
            eventCount++;
            lastEventName = (event as { event?: string }).event ?? '<no-event-field>';
            cliLog?.info('deploy_event', {
              eventCount,
              event: lastEventName,
              raw: line.slice(0, 200),
            });
            yield event;
          }
        }
      }
    } catch (err) {
      cliLog?.error('deploy_stream_error', err, {
        bytesRead,
        eventCount,
        lastEvent: lastEventName,
      });
      throw err;
    }
  }

  async listSecrets(projectId: string): Promise<Array<{ name: string }>> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/secrets`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list secrets', res);
    }

    return res.json();
  }

  async setSecret(projectId: string, name: string, value: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({ value }),
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to set secret', res);
    }

    return res.json();
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete project', res);
    }

    return res.json();
  }

  async getMigrationStatus(
    projectId: string,
    dialect?: 'sqlite' | 'postgresql' | 'mysql',
  ): Promise<{ applied: Array<{ name: string; applied_at: string }> }> {
    const url = new URL(`${this.baseUrl}/projects/${projectId}/migrations`);
    if (dialect) {
      url.searchParams.set('dialect', dialect);
    }
    const res = await fetch(url, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get migration status', res);
    }

    return res.json();
  }

  async applyRemoteMigrations(
    projectId: string,
    migrations: Array<{ name: string; sql: string }>,
  ): Promise<{
    ok: boolean;
    applied: Array<string>;
    skipped: Array<string>;
    error?: string;
    migration_protocol?: 'stable' | 'legacy';
    migration_stability?: 'stable' | 'legacy';
    warnings?: Array<string>;
  }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ migrations }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to apply remote migrations', res);
    }

    return res.json();
  }

  async renameMigrations(
    projectId: string,
    renames: Array<{ from: string; to: string }>,
  ): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ renames }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to rename remote migrations', res);
    }

    return res.json();
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ hostname }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add domain', res);
    }

    return res.json();
  }

  async listDomains(projectId: string): Promise<Array<DomainResponse>> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list domains', res);
    }

    return res.json();
  }

  async getDomainStatus(projectId: string, domainId: string): Promise<DomainStatusResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get domain status', res);
    }

    return res.json();
  }

  async removeDomain(projectId: string, domainId: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove domain', res);
    }

    return res.json();
  }

  async deleteSecret(projectId: string, name: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete secret', res);
    }

    return res.json();
  }

  async getResources(projectId: string): Promise<Array<{ type: string; binding_name: string }>> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/resources`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get resources', res);
    }

    return res.json();
  }

  async createPrerenderToken(projectId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/prerender-token`, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to create prerender token', res);
    }

    const body = (await res.json()) as { token: string };
    return body.token;
  }

  async provisionDatabase(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/database`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to provision database', res);
    }

    return res.json();
  }

  async setDatabaseUrl(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/database-url`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to update database URL', res);
    }

    return res.json();
  }

  async getDatabaseUrl(projectId: string): Promise<{ url: string }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/database-url`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch database URL', res);
    }

    return res.json();
  }

  async purgeCache(projectId: string): Promise<{ purged: number }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ all: true }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Cache purge failed', res);
    }

    return res.json();
  }

  async getLogs(
    projectId: string,
    since: string,
    limit = 200,
    deploymentId?: string,
    level?: string,
  ): Promise<Array<LogEntry>> {
    const params = new URLSearchParams({
      since,
      limit: String(limit),
    });
    if (deploymentId) {
      params.set('deploymentId', deploymentId);
    }
    if (level && level !== 'all') {
      params.set('level', level);
    }

    const res = await fetch(`${this.baseUrl}/projects/${projectId}/logs?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch logs', res);
    }

    const json = (await res.json()) as { data: Array<LogEntry> };
    return json.data;
  }

  async getRequests(
    projectId: string,
    since: string,
    limit = 200,
    status?: string,
  ): Promise<Array<RequestEntry>> {
    const params = new URLSearchParams({
      since,
      limit: String(limit),
    });
    if (status && status !== 'all') {
      params.set('status', status);
    }

    const res = await fetch(`${this.baseUrl}/projects/${projectId}/requests?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch requests', res);
    }

    const json = (await res.json()) as { data: Array<RequestEntry> };
    return json.data;
  }

  async listBuilds(projectId: string, limit = 20): Promise<Array<BuildSummary>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/builds?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list builds', res);
    }

    const json = (await res.json()) as { builds: Array<BuildSummary> };
    return json.builds;
  }

  async getBuildLogs(projectId: string, buildId: string, since = 0): Promise<BuildLogsResponse> {
    const params = new URLSearchParams({ since: String(since) });
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/builds/${buildId}/logs?${params}`,
      {
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch build logs', res);
    }

    return res.json();
  }

  async getGithubInstallUrl(): Promise<{ url: string }> {
    const res = await fetch(`${this.baseUrl}/github/install-url`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get GitHub install URL', res);
    }

    return res.json();
  }

  async listGithubInstallations(): Promise<Array<GithubInstallation>> {
    const res = await fetch(`${this.baseUrl}/github/installations`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list GitHub installations', res);
    }

    return res.json();
  }

  async connectGithub(
    projectId: string,
    body: {
      installationId: string;
      repoFullName: string;
      branch?: string;
      buildExecutor?: 'container' | 'github_actions';
      workflowPath?: string;
      connectGrant?: string;
      codeVerifier?: string;
    },
  ): Promise<GithubConnection> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to connect GitHub repository', res);
    }

    return res.json();
  }

  /**
   * Start the per-repo connect-authorization round-trip used by a non-owner org
   * member (Task 7 platform contract). The callback redirects back to `redirect`
   * with either `?connect_grant=<signed>` (proof of per-repo access) or
   * `?error=repo_not_accessible`. Mirrors {@link getGithubLinkUrl} but carries
   * the installation + repo the grant is scoped to.
   */
  async getGithubConnectAuthorizeUrl(
    redirect: string,
    codeChallenge: string,
    installationId: string,
    repoFullName: string,
  ): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      installationId,
      repoFullName,
    });
    const res = await fetch(`${this.baseUrl}/github/connect-authorize-url?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to start GitHub connect authorization', res);
    }

    return res.json();
  }

  async getGithubConnection(projectId: string): Promise<GithubConnection> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/github`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get GitHub connection', res);
    }

    return res.json();
  }

  async updateGithubConnection(
    projectId: string,
    body: {
      branch?: string;
      buildExecutor?: 'container' | 'github_actions';
      workflowPath?: string;
    },
  ): Promise<GithubConnection> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to update GitHub connection', res);
    }

    return res.json();
  }

  async deleteGithubConnection(projectId: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to disconnect GitHub repository', res);
    }

    return res.json();
  }

  async getGithubLinkUrl(redirect: string, codeChallenge: string): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${this.baseUrl}/github/link-url?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to start GitHub link', res);
    }

    return res.json();
  }

  async completeGithubLink(
    linkCode: string,
    codeVerifier: string,
  ): Promise<{ status: 'linked' | 'already_linked' }> {
    const res = await fetch(`${this.baseUrl}/github/link/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ link_code: linkCode, code_verifier: codeVerifier }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to complete GitHub link', res);
    }

    return res.json();
  }

  async getGithubJoinUrl(redirect: string, codeChallenge: string): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${this.baseUrl}/github/join-url?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to start GitHub join', res);
    }

    return res.json();
  }

  async completeGithubJoin(
    joinCode: string,
    codeVerifier: string,
  ): Promise<{ status: 'joined'; count: number }> {
    const res = await fetch(`${this.baseUrl}/github/join/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ join_code: joinCode, code_verifier: codeVerifier }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to complete GitHub join', res);
    }

    return res.json();
  }

  async getEmailUsage(projectId: string): Promise<EmailUsageResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/email/usage`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email usage', res);
    }

    return res.json();
  }

  async getEmailLogs(projectId: string, limit?: number): Promise<EmailLogsResponse> {
    const url = new URL(`${this.baseUrl}/projects/${projectId}/email/logs`);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }

    const res = await fetch(url, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email logs', res);
    }

    return res.json();
  }

  async listEmailDestinations(projectId: string): Promise<Array<EmailDestinationResponse>> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/email/destinations`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list email destinations', res);
    }

    return res.json();
  }

  async addEmailDestination(
    projectId: string,
    address: string,
  ): Promise<EmailDestinationResponse & { created: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/email/destinations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ address }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add email destination', res);
    }

    // 201 registered the address just now; 200 found it already on the
    // project's list. The body is the same shape either way, so the status
    // is the "created" signal — whether a link went out is the body's
    // `verificationSent` / `platformVerificationPending`, not the status.
    const body = (await res.json()) as EmailDestinationResponse;
    return { ...body, created: res.status === 201 };
  }

  async removeEmailDestination(projectId: string, destinationId: string): Promise<{ ok: boolean }> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/email/destinations/${destinationId}`,
      {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove email destination', res);
    }

    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
