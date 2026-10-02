import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { cfAccessHeaders } from '../shared/cf-access.ts';
import { getPackageDir } from './agents.ts';
import { getApiUrl } from './auth.ts';
import {
  ensureCloudflaredToken,
  ensurePlatformAccessToken,
  isCloudflareAccessChallenge,
} from './cf-access.ts';
import type { CliLogger } from './log-file.ts';
import { readPlatformDiscoveryResponse } from './platform-discovery.ts';
import {
  formatPlatformApiError,
  parsePlatformErrorBody,
  platformErrorMessage,
  type ProjectPermission,
} from './platform-errors.ts';
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

/** The oldest Void platform release this CLI supports. */
export const MIN_PLATFORM_VERSION = '0.23.0';

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Version checks keyed by platform base URL. Every outcome (pass, inconclusive,
 * or too old) is kept for the rest of the process, so polling commands probe
 * discovery once.
 */
const platformVersionChecks = new Map<string, Promise<void>>();

/**
 * What public discovery says about the platform version:
 * - `version`: the reported `platformVersion`
 * - `missing`: discovery answered 404, so the platform predates discovery
 * - `unknown`: no usable answer (network error, timeout, disabled platform,
 *   Access login page, or an invalid document)
 */
type PlatformVersionProbe =
  | { kind: 'version'; version: string }
  | { kind: 'missing' }
  | { kind: 'unknown' };

/**
 * Returns whether `version` is older than MIN_PLATFORM_VERSION, or null when
 * it is not a release version. A prerelease sorts before its release.
 */
function isOlderThanMinimumPlatform(version: string): boolean | null {
  const actual = RELEASE_VERSION.exec(version);
  const minimum = RELEASE_VERSION.exec(MIN_PLATFORM_VERSION)!;
  if (!actual) {
    return null;
  }
  for (const part of [1, 2, 3]) {
    const difference = Number(actual[part]) - Number(minimum[part]);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return actual[4] !== undefined && minimum[4] === undefined;
}

const UPGRADE_PLATFORM_ACTION =
  'Ask its administrator to upgrade the platform runtime with `void platform upgrade`.';

function assertSupportedPlatform(apiUrl: string, probe: PlatformVersionProbe): void {
  if (probe.kind === 'unknown') {
    // Let the real request run and report its own error.
    return;
  }
  if (probe.kind === 'missing') {
    // Every Void platform release serves discovery, so a 404 there means a
    // platform that predates it, and therefore predates the minimum.
    throw new Error(
      `The Void platform at ${apiUrl} does not report its version, but this CLI requires ${MIN_PLATFORM_VERSION} or later. ${UPGRADE_PLATFORM_ACTION}`,
    );
  }
  const { version } = probe;
  // Installed and hosted platforms report their release version. "hosted"
  // comes from a hosted deployment that does not set PLATFORM_VERSION yet.
  // Any other value that is not a release version comes from a custom or
  // development build and cannot be ordered. Both pass.
  if (version === 'hosted' || isOlderThanMinimumPlatform(version) !== true) {
    return;
  }
  throw new Error(
    `The Void platform at ${apiUrl} runs version ${version}, but this CLI requires ${MIN_PLATFORM_VERSION} or later. ${UPGRADE_PLATFORM_ACTION}`,
  );
}

export { parsePlatformErrorBody } from './platform-errors.ts';
export type { PlatformErrorPayload } from './platform-errors.ts';

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

  constructor(action: string, status: number, body: string, permission?: ProjectPermission) {
    const parsed = parsePlatformErrorBody(body);
    super(formatPlatformApiError(action, status, body, permission));
    this.name = 'PlatformApiError';
    this.status = status;
    this.body = body;
    this.code = parsed?.error ?? parsed?.message;
  }
}

async function throwPlatformApiError(
  action: string,
  res: Response,
  permission?: ProjectPermission,
): Promise<never> {
  throw new PlatformApiError(
    action,
    res.status,
    await res.text(),
    isCloudflareAccessChallenge(res) ? undefined : permission,
  );
}

export function isExpiredTokenError(error: unknown): boolean {
  if (error instanceof PlatformApiError) {
    return error.status === 401 && error.code === 'invalid or expired token';
  }
  return false;
}

function isPreflightRejection(error: unknown): boolean {
  return (
    error instanceof PlatformApiError &&
    (([401, 403].includes(error.status) && !!parsePlatformErrorBody(error.body)?.error) ||
      isCliOutdatedError(error))
  );
}

export type ProjectResponse = {
  url?: string;
  id: string;
  user_id: string;
  slug: string;
  type: string;
  created_at: string;
  custom_domain: string | null;
  role: ProjectRole;
  owner?: {
    id: string;
    login?: string;
  };
};

export type ProjectRole = 'reader' | 'collaborator' | 'admin' | 'owner';

export type ProjectMemberResponse = {
  role: ProjectRole;
  created_at: string;
  user: {
    id: string;
    login: string | null;
  };
};

export type ProjectInvitationResponse = {
  id: string;
  target_email?: string;
  role: Exclude<ProjectRole, 'owner'>;
  status?: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  project?: {
    id: string;
    slug: string;
    owner?: {
      id: string;
      login: string | null;
    };
  };
  target?: {
    id: string;
    login: string | null;
    email: string | null;
  };
  invited_by?: {
    id: string;
    login: string | null;
  };
};

type ProjectInvitationDelivery = {
  status: 'sent' | 'not_configured' | 'rate_limited' | 'failed';
};

export type ProjectDeployCredentialResponse = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type ProjectZeroTrustState = {
  project_id: string;
  desired_protected: boolean;
  effective_protected: boolean;
  state: 'public' | 'protected' | 'reconciling' | 'error';
  last_error: string | null;
  updated_at: string;
};

/** `GET /projects/:id/zero-trust`. */
export type ProjectZeroTrustResponse = {
  /** Whether a project owner or admin can change protection now. */
  available: boolean;
  platformStatus:
    | 'not_configured'
    | 'invalid_configuration'
    | 'configuring'
    | 'ready'
    | 'disabling'
    | 'error';
  protectNewProjects: boolean;
  project: ProjectZeroTrustState | null;
};

/** `PUT /projects/:id/zero-trust` and `POST /projects/:id/zero-trust/reconcile`. */
export type ProjectZeroTrustUpdateResponse = {
  ok: true;
  project: ProjectZeroTrustState;
};

export type IssuedProjectDeployCredentialResponse = ProjectDeployCredentialResponse & {
  token: string;
};

export type CreateProjectResponse = {
  url?: string;
  id: string;
  slug: string;
  warnings?: Array<string>;
  zero_trust?: ProjectZeroTrustState;
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
  logsComplete: boolean | null;
  external: string | null;
};

export type EmailUsageResponse = {
  month: string;
  attempts: number;
  received: number;
  limit: number;
  remaining: number;
  suspended: boolean;
};

export type EmailLogEntry = {
  timestamp: number;
  direction: 'sent' | 'received';
  operationId: string;
  receiptId: string | null;
  recipient: string | null;
  status: string;
  transport: string;
  providerReference: string | null;
  errorCode: string | null;
  policyVersion: number | null;
};

export type EmailLogsResponse = {
  logs: Array<EmailLogEntry>;
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

/** GET /projects/:id/email/settings — installation settings the CLI reads before acting. */
export type EmailSettingsResponse = {
  domains: {
    /** `admin`: administrators register email domains; `void email domain add` prints their command. */
    management: 'self-serve' | 'admin';
    projectSlug?: string;
  };
  recipientPolicy?: { mode: 'verified' | 'domains' | 'any'; domains: Array<string> };
  sharedInbound?: {
    recipient: string;
    status: string;
    reason: string | null;
    observedAt: string | null;
  } | null;
};

export type EmailDomainResponse = {
  id: string;
  domain: string;
  projectId: string;
  managed_by: 'owner' | 'admin';
  status: EmailReadiness['inbound']['status'];
  connectionId: string;
  account_id: string;
  zone_id: string;
  relay_worker_name: string;
  relay_version: number | null;
  operationId: string | null;
  operationStatus?: EmailOperationResponse['status'] | null;
  attemptId?: string | null;
  readiness: EmailReadiness;
  error?: string | null;
};

export type EmailReadiness = {
  inbound: {
    status: 'pending' | 'ready' | 'disabled' | 'drifted';
    reason?: string | null;
    observedAt?: string | null;
  };
  outbound: {
    status: 'pending' | 'verified_only' | 'ready' | 'blocked';
    reason?: string | null;
    observedAt?: string | null;
  };
  management: {
    status: 'healthy' | 'expired' | 'revoked' | 'refresh_unknown' | 'probe_failed';
    reason?: string | null;
    observedAt?: string | null;
  };
};

export type EmailOperationResponse = {
  operationId: string;
  attemptId: string;
  status: 'pending' | 'running' | 'blocked' | 'unknown' | 'completed';
  domain: string;
  readiness: EmailReadiness;
  failedStep?: string;
  error?: string;
};

export type EmailDomainStatusResponse = EmailDomainResponse;
export type EmailDomainSyncResponse = EmailDomainResponse;

export type RemoveEmailDomainResponse = {
  operationId: string;
  operationStatus?: EmailOperationResponse['status'];
  error?: string | null;
  ok: boolean;
  removed: boolean;
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
  cname_target: string;
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
  branch: string;
  build_executor: 'container' | 'github_actions';
  workflow_path: string;
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
 *   naming the deployment id. Receipt-aware platforms additionally bind
 *   the stable invocation key to the accepted artifact, so an accepted
 *   request can be recovered without creating another execution. Older
 *   platforms retain their concurrency guard. No client-side deployment
 *   lookup may authorize replay or identify an unrelated conflicting row.
 */
const DEPLOY_POST_MAX_RETRIES = 3;
const DEPLOY_POST_BACKOFF_MS = [1000, 5000, 10000];
const DEPLOY_OBSERVATION_TIMEOUT_MS = 30_000;
const DEPLOY_OBSERVATION_DEADLINE_MS = 30 * 60_000;
const DEPLOY_OBSERVATION_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const DEPLOY_EVENT_MAX_BYTES = 1024 * 1024;

// Heartbeats carry no `seq`. Heartbeat `status` and the observation page
// `heartbeat` come from commit 21d4ec46, which 0.23.0 does not ship; keep them
// optional until MIN_PLATFORM_VERSION includes it. `recoveryAt` is optional:
// it is sent only while an execution lease exists.
type SequencedDeployEvent = DeployEvent & { seq?: number };
class DeploymentProtocolError extends Error {}
class DeploymentObservationTimeoutError extends Error {
  constructor(deploymentId: string) {
    super(`Timed out observing deployment ${deploymentId}. Inspect with \`void project status\`.`);
  }
}

function parseDeployEvent(value: unknown): SequencedDeployEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    !('event' in value) ||
    typeof value.event !== 'string'
  ) {
    throw new DeploymentProtocolError('Invalid deployment event from platform.');
  }
  const event = value as SequencedDeployEvent;
  if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < 1)) {
    throw new DeploymentProtocolError('Invalid deployment event sequence from platform.');
  }
  if (
    (event.event === 'start' && typeof event.deploymentId !== 'string') ||
    (event.event === 'heartbeat' &&
      (typeof event.step !== 'string' ||
        (event.status !== undefined &&
          !['queued', 'running', 'recovering'].includes(event.status)) ||
        (event.recoveryAt !== undefined &&
          (typeof event.recoveryAt !== 'string' ||
            !Number.isFinite(Date.parse(event.recoveryAt)))))) ||
    (event.event === 'done' &&
      (typeof event.deployment !== 'string' ||
        typeof event.url !== 'string' ||
        !Array.isArray(event.urls) ||
        !event.urls.every((url) => typeof url === 'string') ||
        !Number.isSafeInteger(event.assets) ||
        event.assets < 0 ||
        !Number.isSafeInteger(event.workers) ||
        event.workers < 0 ||
        (event.published !== undefined && typeof event.published !== 'boolean'))) ||
    (event.event === 'error' &&
      (typeof event.message !== 'string' || typeof event.step !== 'string'))
  ) {
    throw new DeploymentProtocolError('Invalid deployment result from platform.');
  }
  return event;
}

/**
 * HTTP client for the Void platform API.
 */
export class PlatformClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly accessHeaders: Record<string, string>;
  private readonly cliLog?: CliLogger;
  private readonly checkPlatformVersion: boolean;
  readonly apiUrl: string;

  /**
   * `checkPlatformVersion: false` skips the minimum platform version check.
   * Only login uses it, so users can still sign in to an older platform.
   */
  constructor(
    token: string,
    options?:
      | string
      | { apiUrl?: string; root?: string; cliLog?: CliLogger; checkPlatformVersion?: boolean },
  ) {
    if (typeof options === 'string') {
      this.baseUrl = normalizePlatformApiUrl(options);
      this.checkPlatformVersion = true;
    } else {
      this.baseUrl = normalizePlatformApiUrl(options?.apiUrl ?? getApiUrl(options?.root));
      this.cliLog = options?.cliLog;
      this.checkPlatformVersion = options?.checkPlatformVersion !== false;
    }
    this.apiUrl = this.baseUrl;
    ensureCloudflaredToken(this.baseUrl);
    this.accessHeaders = cfAccessHeaders(process.env, this.baseUrl);
    this.authHeaders = {
      Authorization: `Bearer ${token}`,
      // Conditional spread: omit the header entirely if package.json was
      // unreadable. The platform's gate treats missing as pass-through;
      // sending a placeholder like "unknown" would trip the fail-closed
      // 426 path and brick the CLI permanently.
      ...(VOID_CLI_VERSION !== null && { 'X-Void-CLI-Version': VOID_CLI_VERSION }),
    };
  }

  private async request(url: string | URL, options: RequestInit = {}): Promise<Response> {
    if (new URL(url).origin !== this.baseUrl) {
      throw new Error('Platform credentials cannot be sent to another origin.');
    }
    if (this.checkPlatformVersion) {
      await this.ensureSupportedPlatform();
    }
    return this.send(url, options);
  }

  /**
   * Checks the platform version once per process and base URL. Concurrent
   * first requests share one check, and its outcome is kept for later requests.
   */
  private ensureSupportedPlatform(): Promise<void> {
    const apiUrl = this.baseUrl;
    const cached = platformVersionChecks.get(apiUrl);
    if (cached) {
      return cached;
    }
    const check = this.probePlatformVersion().then((probe) =>
      assertSupportedPlatform(apiUrl, probe),
    );
    platformVersionChecks.set(apiUrl, check);
    return check;
  }

  /** Reads the platform version from public discovery, without credentials. */
  private async probePlatformVersion(): Promise<PlatformVersionProbe> {
    let response: Response;
    try {
      response = await this.send(`${this.baseUrl}/.well-known/void-platform`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // A network error or timeout says nothing about the version. The real
      // request reports its own error if the platform is unreachable.
      return { kind: 'unknown' };
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { kind: 'missing' };
    }
    try {
      const discovery = await readPlatformDiscoveryResponse(this.baseUrl, response);
      return { kind: 'version', version: discovery.platformVersion };
    } catch {
      return { kind: 'unknown' };
    }
  }

  private async send(url: string | URL, options: RequestInit): Promise<Response> {
    // A service-token pair is long-lived and was captured before managed deploy
    // scrubs the parent environment. User tokens can be renewed in the browser,
    // so keep checking for a newer environment value when no service pair was
    // captured and let current credentials override the fallback below.
    if (!this.accessHeaders['CF-Access-Client-Id']) {
      ensureCloudflaredToken(this.baseUrl);
    }
    const send = () => {
      const currentAccessHeaders = cfAccessHeaders(process.env, this.baseUrl);
      const accessHeaders = this.accessHeaders['CF-Access-Client-Id']
        ? this.accessHeaders
        : Object.keys(currentAccessHeaders).length > 0
          ? currentAccessHeaders
          : this.accessHeaders;
      return {
        accessHeaders,
        response: fetch(url, {
          ...options,
          headers: {
            ...(options.headers as Record<string, string>),
            ...accessHeaders,
          },
          redirect: 'manual',
        }),
      };
    };

    const first = send();
    const response = await first.response;
    if (!isCloudflareAccessChallenge(response)) {
      return response;
    }

    // Service-token rejection is an operator/CI configuration error. Never
    // replace a scoped machine credential with an interactive human session.
    if (first.accessHeaders['CF-Access-Client-Id']) {
      return response;
    }

    await response.body?.cancel();
    ensurePlatformAccessToken(this.baseUrl, true, false, first.accessHeaders['cf-access-token']);
    // One retry only, at the exact original endpoint. `redirect: 'manual'`
    // above means credentials are never forwarded to the challenge Location.
    return send().response;
  }

  async startIdentityLink(
    connectionId: string,
  ): Promise<{ id: string; url: string; expiresAt: string }> {
    const response = await this.request(this.baseUrl + '/auth/link', {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId }),
    });
    if (!response.ok) {
      await throwPlatformApiError('Failed to link login method', response);
    }
    const result = (await response.json()) as { id: string; url: string; expiresAt: string };
    const url = new URL(result.url);
    if (
      url.origin !== this.baseUrl ||
      url.pathname !== '/auth/link' ||
      url.username ||
      url.password
    ) {
      throw new Error('auth: Invalid account-link URL from platform.');
    }
    return result;
  }

  async whoami(): Promise<{ id: string; login: string; plan: string }> {
    const res = await this.request(`${this.baseUrl}/me`, {
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
    const res = await this.request(`${this.baseUrl}/projects`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list projects', res);
    }

    return res.json();
  }

  /** A lightweight project list for interactive linking. */
  async listProjectChoices(): Promise<Array<ProjectResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/choices`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to list project choices', res);
    }
    return res.json();
  }

  /** Resolve one known project without loading account-wide deployment and traffic summaries. */
  async getProject(projectId: string): Promise<ProjectResponse | null> {
    const res = await this.request(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}`, {
      headers: { ...this.authHeaders },
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      await throwPlatformApiError('Failed to get project', res);
    }
    return res.json();
  }

  /** Resolve a slug through the current platform contract. */
  async findProjectBySlug(slug: string): Promise<ProjectResponse | null> {
    const url = new URL(`${this.baseUrl}/projects/resolve`);
    url.searchParams.set('slug', slug);
    const res = await this.request(url.toString(), { headers: { ...this.authHeaders } });
    if (!res.ok) {
      await throwPlatformApiError('Failed to resolve project', res);
    }
    const body = (await res.json()) as { project: ProjectResponse | null };
    return body.project;
  }

  async listProjectTokens(projectId: string): Promise<Array<ProjectDeployCredentialResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/tokens`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to list project tokens', res, 'owner');
    }
    return res.json();
  }

  async getProjectZeroTrust(projectId: string): Promise<ProjectZeroTrustResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/zero-trust`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to inspect project Zero Trust', res, 'read');
    }
    return res.json();
  }

  async setProjectZeroTrust(
    projectId: string,
    protectedProject: boolean,
  ): Promise<ProjectZeroTrustUpdateResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/zero-trust`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders },
      body: JSON.stringify({ protected: protectedProject }),
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to update project Zero Trust', res, 'settings');
    }
    return res.json();
  }

  async reconcileProjectZeroTrust(projectId: string): Promise<ProjectZeroTrustUpdateResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/zero-trust/reconcile`, {
      method: 'POST',
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to reconcile project Zero Trust', res, 'settings');
    }
    return res.json();
  }

  async createProjectToken(
    projectId: string,
    input: { name?: string; expiresInDays?: number },
  ): Promise<IssuedProjectDeployCredentialResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/tokens`, {
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to create project token', res, 'owner');
    }
    return res.json();
  }

  async listProjectMembers(projectId: string): Promise<Array<ProjectMemberResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/members`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to list project members', res, 'read');
    }
    const body = (await res.json()) as { members: Array<ProjectMemberResponse> };
    return body.members;
  }

  async listProjectInvitations(projectId: string): Promise<Array<ProjectInvitationResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/invitations`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to list project invitations', res, 'members');
    }
    const body = (await res.json()) as { invitations: Array<ProjectInvitationResponse> };
    return body.invitations;
  }

  async inviteProjectMember(
    projectId: string,
    email: string,
    role: Exclude<ProjectRole, 'owner'>,
  ): Promise<{
    invitation: ProjectInvitationResponse;
    refreshed: boolean;
    delivery: ProjectInvitationDelivery;
  }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders },
      body: JSON.stringify({ email, role }),
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to invite project member', res, 'members');
    }
    return res.json();
  }

  async renewProjectToken(
    projectId: string,
    credentialId: string,
    expiresInDays?: number,
  ): Promise<IssuedProjectDeployCredentialResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/tokens/${encodeURIComponent(credentialId)}/renew`,
      {
        method: 'POST',
        headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(expiresInDays ? { expiresInDays } : {}),
      },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to renew project token', res, 'owner');
    }
    return res.json();
  }

  async updateProjectMemberRole(
    projectId: string,
    userId: string,
    role: Exclude<ProjectRole, 'owner'>,
  ): Promise<{ member: ProjectMemberResponse }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify({ role }),
      },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to change project member role', res, 'members');
    }
    return res.json();
  }

  async revokeProjectToken(projectId: string, credentialId: string): Promise<{ ok: boolean }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/tokens/${encodeURIComponent(credentialId)}`,
      { method: 'DELETE', headers: { ...this.authHeaders } },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to revoke project token', res, 'owner');
    }
    return res.json();
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE', headers: { ...this.authHeaders } },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to remove project member', res, 'members');
    }
  }

  async revokeProjectInvitation(projectId: string, invitationId: string): Promise<void> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE', headers: { ...this.authHeaders } },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to revoke project invitation', res, 'members');
    }
  }

  async leaveProject(projectId: string): Promise<void> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/leave`, {
      method: 'POST',
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to leave project', res);
    }
  }

  async listPendingProjectInvitations(): Promise<Array<ProjectInvitationResponse>> {
    const res = await this.request(`${this.baseUrl}/me/project-invitations`, {
      headers: { ...this.authHeaders },
    });
    if (!res.ok) {
      await throwPlatformApiError('Failed to list pending project invitations', res);
    }
    const body = (await res.json()) as { invitations: Array<ProjectInvitationResponse> };
    return body.invitations;
  }

  async respondToProjectInvitation(
    invitationId: string,
    action: 'accept' | 'decline',
  ): Promise<void> {
    const res = await this.request(
      `${this.baseUrl}/project-invitations/${encodeURIComponent(invitationId)}/${action}`,
      { method: 'POST', headers: { ...this.authHeaders } },
    );
    if (!res.ok) {
      await throwPlatformApiError(`Failed to ${action} project invitation`, res);
    }
  }

  async listDeployments(projectId: string): Promise<DeploymentListResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/deployments`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list deployments', res, 'read');
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/rollback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Rollback failed', res, 'deploy');
    }

    return res.json();
  }

  async cancelDeployment(
    projectId: string,
    deploymentId: string,
  ): Promise<{ ok: boolean; deploymentId: string; status: string }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/deployments/${deploymentId}/cancel`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Cancel deployment failed', res, 'deploy');
    }

    return res.json();
  }

  async createProject(slug: string): Promise<CreateProjectResponse> {
    const res = await this.request(`${this.baseUrl}/projects`, {
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
      const res = await this.request(`${this.baseUrl}/projects/${projectId}/deploy/preflight`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders,
        },
        body: JSON.stringify({ assetManifest, ...(hasWorker && { hasWorker }) }),
      });

      if (!res.ok) {
        const error = new PlatformApiError(
          'Preflight failed',
          res.status,
          await res.text(),
          isCloudflareAccessChallenge(res) ? undefined : 'deploy',
        );
        if (isPreflightRejection(error)) {
          throw error;
        }
        // Preflight not supported or error — fall back to uploading everything
        return { needed: Object.keys(assetManifest), total, skipped: 0 };
      }

      return res.json();
    } catch (error) {
      if (isPreflightRejection(error)) {
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

    const res = await this.request(url, {
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
      await throwPlatformApiError('Failed to request upload URLs', res, 'deploy');
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
        'x-void-deploy-idempotency-key': crypto.randomUUID(),
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
        res = await this.request(url, init);
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
        const parsed = parsePlatformErrorBody(body);
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
              `${platformErrorMessage(parsed) ?? platformErrorMessage({ message: parsed.error }) ?? 'deploy in progress'}: deployment ${parsed.deployment} — ` +
              'it may be an earlier attempt of this deploy or a concurrent one; ' +
              'inspect with `void project status` before redeploying',
          };
          return;
        }
      }
      throw new PlatformApiError(
        'Deploy failed',
        res.status,
        body,
        isCloudflareAccessChallenge(res) ? undefined : 'deploy',
      );
    }

    const receipt = res.headers.get('x-void-deployment-id');
    const observationDeadline = Date.now() + DEPLOY_OBSERVATION_DEADLINE_MS;
    if (receipt === null || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt)) {
      void res.body?.cancel().catch(() => {});
      throw new Error(
        receipt === null
          ? 'Platform returned no deployment receipt.'
          : 'Invalid deployment receipt from platform.',
      );
    }
    let cursor = 0;
    let terminal = false;
    // The platform owns execution independently of this observer. Capturing
    // the ID before the first byte also permits recovery when start was lost.
    if (!res.body) {
      yield { event: 'start', deploymentId: receipt };
      yield* this.followDeploymentEvents(projectId, receipt, cursor, observationDeadline);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bytesRead = 0;
    let firstByteAt: number | null = null;
    const startedAt = Date.now();
    let eventCount = 0;
    let lastEventName = '<none>';
    let streamFinished = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const remaining = observationDeadline - Date.now();
      if (remaining <= 0) {
        throw new DeploymentObservationTimeoutError(receipt);
      }
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            readTimer = setTimeout(
              () =>
                reject(
                  Date.now() >= observationDeadline
                    ? new DeploymentObservationTimeoutError(receipt)
                    : new TypeError('Deployment event stream timed out.'),
                ),
              Math.min(DEPLOY_OBSERVATION_TIMEOUT_MS, remaining),
            );
          }),
        ]);
      } finally {
        clearTimeout(readTimer);
      }
    };
    const parseLine = (line: string): SequencedDeployEvent | null => {
      if (Buffer.byteLength(line) > DEPLOY_EVENT_MAX_BYTES) {
        throw new DeploymentProtocolError('Deployment event exceeds the platform response limit.');
      }
      if (!line.trim()) {
        return null;
      }
      const event = parseDeployEvent(JSON.parse(line));
      if (event.seq !== undefined) {
        if (event.seq <= cursor) {
          return null;
        }
        cursor = event.seq;
      }
      eventCount++;
      lastEventName = event.event;
      cliLog?.info('deploy_event', { eventCount, event: lastEventName, raw: line.slice(0, 200) });
      // The receipt already supplied start, but still advance its sequence.
      if (event.event === 'start') {
        return null;
      }
      terminal = event.event === 'done' || event.event === 'error';
      return event;
    };

    try {
      yield { event: 'start', deploymentId: receipt };
      while (true) {
        const { done, value } = await read();
        if (Date.now() >= observationDeadline) {
          throw new DeploymentObservationTimeoutError(receipt);
        }
        if (done) {
          streamFinished = true;
          buffer += decoder.decode();
          const event = parseLine(buffer);
          if (event) {
            yield event;
          }
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
          const event = parseLine(line);
          if (event) {
            yield event;
            if (terminal) {
              return;
            }
          }
        }
        if (Buffer.byteLength(buffer) > DEPLOY_EVENT_MAX_BYTES) {
          throw new DeploymentProtocolError(
            'Deployment event exceeds the platform response limit.',
          );
        }
      }
    } catch (err) {
      cliLog?.error('deploy_stream_error', err, {
        bytesRead,
        eventCount,
        lastEvent: lastEventName,
      });
      // Parse/protocol errors are not transient transport failures. Never hide
      // them behind polling, and never replay a POST that yielded a receipt.
      if (
        err instanceof DeploymentObservationTimeoutError ||
        err instanceof DeploymentProtocolError ||
        err instanceof SyntaxError ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        throw err;
      }
    } finally {
      clearTimeout(readTimer);
      if (!streamFinished) {
        // An underlying cancellation can stall; observer cleanup must not wait
        // indefinitely for a closed or broken network connection.
        void reader.cancel().catch(() => {});
      }
      reader.releaseLock();
    }
    if (!terminal) {
      yield* this.followDeploymentEvents(projectId, receipt, cursor, observationDeadline);
    }
  }

  private async *followDeploymentEvents(
    projectId: string,
    deploymentId: string,
    since: number,
    deadline: number,
  ): AsyncGenerator<DeployEvent> {
    let cursor = since;
    let failures = 0;
    while (Date.now() < deadline) {
      const url = `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/events?since=${cursor}`;
      let page: {
        deploymentId: string;
        events: Array<{ seq: number; event: unknown }>;
        lastSeq: number;
        terminal: boolean;
        heartbeat?: unknown;
      };
      try {
        const response = await this.request(url, {
          headers: { ...this.authHeaders },
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(DEPLOY_OBSERVATION_TIMEOUT_MS, deadline - Date.now())),
          ),
        });
        if (!response.ok) {
          await throwPlatformApiError('Failed to observe deployment', response, 'read');
        }
        page = (await response.json()) as typeof page;
        if (Date.now() >= deadline) {
          throw new DeploymentObservationTimeoutError(deploymentId);
        }
      } catch (err) {
        const transient =
          err instanceof TypeError ||
          (err instanceof DOMException && err.name === 'TimeoutError') ||
          (err instanceof PlatformApiError && (err.status === 429 || err.status >= 500));
        if (!transient || failures >= DEPLOY_OBSERVATION_BACKOFF_MS.length) {
          throw err;
        }
        const delayMs = DEPLOY_OBSERVATION_BACKOFF_MS[failures++];
        this.cliLog?.warn('deploy_observation_retry', { deploymentId, cursor, delayMs });
        await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      failures = 0;
      if (
        !page ||
        page.deploymentId !== deploymentId ||
        !Array.isArray(page.events) ||
        page.events.length > 1000 ||
        !Number.isSafeInteger(page.lastSeq) ||
        page.lastSeq < cursor ||
        typeof page.terminal !== 'boolean'
      ) {
        throw new Error('Invalid deployment observation response from platform.');
      }
      let previousSeq = 0;
      for (const row of page.events) {
        if (
          !row ||
          !Number.isSafeInteger(row.seq) ||
          row.seq <= previousSeq ||
          row.seq > page.lastSeq
        ) {
          throw new Error('Invalid deployment observation sequence from platform.');
        }
        previousSeq = row.seq;
        const event = parseDeployEvent(row.event);
        if (row.seq <= cursor) {
          continue;
        }
        cursor = row.seq;
        if (event.event !== 'start') {
          yield event;
        }
        if (event.event === 'done' || event.event === 'error') {
          return;
        }
      }
      // Never skip a missing event merely because the server advertises a
      // later high-water mark. Only consumed events advance the cursor.
      if (page.terminal) {
        throw new Error('Platform finished deployment without a terminal result.');
      }
      if (page.heartbeat !== undefined) {
        const heartbeat = parseDeployEvent(page.heartbeat);
        if (
          heartbeat.event !== 'heartbeat' ||
          (heartbeat.deploymentId !== undefined && heartbeat.deploymentId !== deploymentId)
        ) {
          throw new DeploymentProtocolError('Invalid deployment observation heartbeat.');
        }
        yield heartbeat;
      }
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    throw new DeploymentObservationTimeoutError(deploymentId);
  }

  async listSecrets(projectId: string): Promise<Array<{ name: string }>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/secrets`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list secrets', res, 'configure');
    }

    return res.json();
  }

  async setSecret(projectId: string, name: string, value: string): Promise<SecretResponse> {
    const res = await this.request(
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
      await throwPlatformApiError('Failed to set secret', res, 'configure');
    }

    return res.json();
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete project', res, 'owner');
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
    const res = await this.request(url, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get migration status', res, 'read');
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/migrations/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ migrations }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to apply remote migrations', res, 'configure');
    }

    return res.json();
  }

  async renameMigrations(
    projectId: string,
    renames: Array<{ from: string; to: string }>,
  ): Promise<{ ok: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/migrations/rename`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ renames }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to rename remote migrations', res, 'configure');
    }

    return res.json();
  }

  async addDomain(projectId: string, hostname: string): Promise<DomainResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/domains`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ hostname }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add domain', res, 'settings');
    }

    return res.json();
  }

  async listDomains(projectId: string): Promise<Array<DomainResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/domains`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list domains', res, 'read');
    }

    return res.json();
  }

  async getDomainStatus(projectId: string, domainId: string): Promise<DomainStatusResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get domain status', res, 'read');
    }

    return res.json();
  }

  async removeDomain(projectId: string, domainId: string): Promise<{ ok: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove domain', res, 'settings');
    }

    return res.json();
  }

  async deleteSecret(projectId: string, name: string): Promise<SecretResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to delete secret', res, 'configure');
    }

    return res.json();
  }

  async getResources(projectId: string): Promise<Array<{ type: string; binding_name: string }>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/resources`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get resources', res, 'read');
    }

    return res.json();
  }

  async createPrerenderToken(projectId: string): Promise<string> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/prerender-token`, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to create prerender token', res, 'deploy');
    }

    const body = (await res.json()) as { token: string };
    return body.token;
  }

  async provisionDatabase(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/database`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to provision database', res, 'configure');
    }

    return res.json();
  }

  async setDatabaseUrl(projectId: string, connectionString: string): Promise<{ ok: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/database-url`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ connectionString }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to update database URL', res, 'configure');
    }

    return res.json();
  }

  async getDatabaseUrl(projectId: string): Promise<{ url: string }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/database-url`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch database URL', res, 'owner');
    }

    return res.json();
  }

  async purgeCache(projectId: string): Promise<{ purged: number }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ all: true }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Cache purge failed', res, 'deploy');
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

    const res = await this.request(`${this.baseUrl}/projects/${projectId}/logs?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch logs', res, 'read');
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

    const res = await this.request(`${this.baseUrl}/projects/${projectId}/requests?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch requests', res, 'read');
    }

    const json = (await res.json()) as { data: Array<RequestEntry> };
    return json.data;
  }

  async listBuilds(projectId: string, limit = 20): Promise<Array<BuildSummary>> {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/builds?${params}`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list builds', res, 'read');
    }

    const json = (await res.json()) as { builds: Array<BuildSummary> };
    return json.builds;
  }

  async getBuildLogs(projectId: string, buildId: string, since = 0): Promise<BuildLogsResponse> {
    const params = new URLSearchParams({ since: String(since) });
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/builds/${buildId}/logs?${params}`,
      {
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch build logs', res, 'read');
    }

    return res.json();
  }

  async getGithubInstallUrl(): Promise<{ url: string }> {
    const res = await this.request(`${this.baseUrl}/github/install-url`, {
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
    const res = await this.request(`${this.baseUrl}/github/installations`, {
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to connect GitHub repository', res, 'settings');
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
    const res = await this.request(`${this.baseUrl}/github/connect-authorize-url?${params}`, {
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/github`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to get GitHub connection', res, 'read');
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to update GitHub connection', res, 'settings');
    }

    return res.json();
  }

  async deleteGithubConnection(projectId: string): Promise<{ ok: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/github`, {
      method: 'DELETE',
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to disconnect GitHub repository', res, 'settings');
    }

    return res.json();
  }

  async getGithubLinkUrl(redirect: string, codeChallenge: string): Promise<{ url: string }> {
    const params = new URLSearchParams({
      redirect,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const res = await this.request(`${this.baseUrl}/github/link-url?${params}`, {
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
    const res = await this.request(`${this.baseUrl}/github/link/complete`, {
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
    const res = await this.request(`${this.baseUrl}/github/join-url?${params}`, {
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
    const res = await this.request(`${this.baseUrl}/github/join/complete`, {
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
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/usage`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email usage', res, 'read');
    }

    return res.json();
  }

  async getEmailLogs(projectId: string, limit?: number): Promise<EmailLogsResponse> {
    const url = new URL(`${this.baseUrl}/projects/${projectId}/email/logs`);
    if (limit !== undefined) {
      url.searchParams.set('limit', String(limit));
    }

    const res = await this.request(url, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email logs', res, 'read');
    }

    return res.json();
  }

  async getEmailOperation(projectId: string, operationId: string): Promise<EmailOperationResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/email/operations/${encodeURIComponent(operationId)}`,
      { headers: { ...this.authHeaders } },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email operation', res, 'read');
    }
    return res.json();
  }

  async listEmailDestinations(projectId: string): Promise<Array<EmailDestinationResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/destinations`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list email destinations', res, 'read');
    }

    return res.json();
  }

  async addEmailDestination(
    projectId: string,
    address: string,
  ): Promise<EmailDestinationResponse & { created: boolean }> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/destinations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({ address }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add email destination', res, 'settings');
    }

    // 201 registered the address just now; 200 found it already on the
    // project's list. The body is the same shape either way, so the status
    // is the "created" signal — whether a link went out is the body's
    // `verificationSent` / `platformVerificationPending`, not the status.
    const body = (await res.json()) as EmailDestinationResponse;
    return { ...body, created: res.status === 201 };
  }

  async removeEmailDestination(projectId: string, destinationId: string): Promise<{ ok: boolean }> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/email/destinations/${destinationId}`,
      {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove email destination', res, 'settings');
    }

    return res.json();
  }

  /** Installation email settings the CLI reads before starting a credential flow. */
  async getEmailSettings(projectId: string): Promise<EmailSettingsResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/settings`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to read email settings', res, 'read');
    }

    return res.json();
  }

  async listEmailDomains(projectId: string): Promise<Array<EmailDomainResponse>> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/domains`, {
      headers: {
        ...this.authHeaders,
      },
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to list email domains', res, 'read');
    }

    return res.json();
  }

  /** Submit a scoped token once; later operations address the domain without it. */
  async addEmailDomain(
    projectId: string,
    input: { domain: string; apiToken?: string; attemptId?: string },
  ): Promise<EmailDomainResponse> {
    const res = await this.request(`${this.baseUrl}/projects/${projectId}/email/domains`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify({
        domain: input.domain,
        ...(input.apiToken !== undefined ? { apiToken: input.apiToken } : {}),
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
      }),
    });

    if (!res.ok) {
      await throwPlatformApiError('Failed to add email domain', res, 'settings');
    }

    return res.json();
  }

  async getEmailDomain(projectId: string, domain: string): Promise<EmailDomainStatusResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}`,
      {
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to fetch email domain status', res, 'read');
    }

    return res.json();
  }

  /** Rotates the shared zone connection secret. */
  async rotateEmailDomainSecret(
    projectId: string,
    domain: string,
    attemptId: string,
  ): Promise<EmailDomainResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}/rotate-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders },
        body: JSON.stringify({ attemptId }),
      },
    );
    if (!res.ok) {
      await throwPlatformApiError('Failed to rotate email connection secret', res, 'settings');
    }
    return res.json();
  }

  async syncEmailDomain(projectId: string, domain: string): Promise<EmailDomainSyncResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}/sync`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to sync email domain', res, 'settings');
    }

    return res.json();
  }

  async removeEmailDomain(projectId: string, domain: string): Promise<RemoveEmailDomainResponse> {
    const res = await this.request(
      `${this.baseUrl}/projects/${projectId}/email/domains/${encodeURIComponent(domain)}`,
      {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
        },
      },
    );

    if (!res.ok) {
      await throwPlatformApiError('Failed to remove email domain', res, 'settings');
    }

    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
