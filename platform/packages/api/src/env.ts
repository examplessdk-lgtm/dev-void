import type { Env } from 'hono';
import type { Db } from './db.ts';
import type { SandboxConcurrencyCounter } from './sandbox-concurrency-counter.ts';
import type { User } from './types.ts';

/**
 * Returns true when DEV_AUTH_BYPASS is exactly the string `'true'` and we are
 * NOT in production.  Any other value — including `'false'`, `'0'`, `'no'`,
 * `'TRUE'`, or an accidental typo — returns false (fail-closed).  Cloudflare
 * env vars are always strings, so the strict equality guards against
 * `DEV_AUTH_BYPASS='false'` accidentally enabling the bypass.
 *
 * PLATFORM_ENV defaults to production for unknown values — only unset
 * (local dev) and `'staging'` are treated as non-production.
 */
export function isDevBypass(env: { DEV_AUTH_BYPASS?: string; PLATFORM_ENV?: string }): boolean {
  if (env.DEV_AUTH_BYPASS !== 'true') {
    return false;
  }
  const platformEnv = env.PLATFORM_ENV;
  return platformEnv === undefined || platformEnv === '' || platformEnv === 'staging';
}

export type ApiEnv = Env & {
  Bindings: {
    HYPERDRIVE: Hyperdrive;
    ISR_CACHE: KVNamespace;
    ROUTING: KVNamespace;
    STATIC_ASSETS: KVNamespace;
    STATIC_ASSETS_R2: R2Bucket;
    DISPATCH: DispatchNamespace;
    CF_API_TOKEN: string;
    CF_ACCOUNT_ID: string;
    CF_ZONE_ID: string;
    JWT_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_PREVIEW_REPO_PAT?: string;
    /**
     * GitHub App credentials for the "Deploy on GitHub" build system. Distinct
     * from the OAuth-login `GITHUB_CLIENT_ID/SECRET` above. All optional so old
     * code (and environments without the App configured) tolerates absence —
     * the webhook/OIDC routes return inert when these are unset.
     */
    GITHUB_APP_ID?: string;
    /** App private key in PKCS#8 PEM form (`openssl pkcs8 -topk8 -nocrypt`). */
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    GITHUB_APP_SLUG?: string;
    /**
     * GitHub App user-to-server OAuth credentials (the App's own client id/secret,
     * distinct from `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` and from the login
     * `GITHUB_CLIENT_ID/SECRET`). Used to verify installation ownership for
     * organization installs via `GET /user/installations` when the App has
     * "Request user authorization (OAuth) during installation" enabled. Optional:
     * when unset, the install callback falls back to the personal account-id match.
     */
    GITHUB_APP_CLIENT_ID?: string;
    GITHUB_APP_CLIENT_SECRET?: string;
    /**
     * CF Access service-token pair for reaching the Access-gated staging hosts
     * (`api.staging.void.cloud`). Held ONLY by the staging API worker. The
     * `BuildManager` forwards these into a staging container build so the
     * `void deploy` child can authenticate past CF Access when calling the
     * staging deploy endpoint — non-interactive automation can't do the
     * `cloudflared` browser flow. Optional: unset everywhere except staging, so
     * production (not Access-gated) and dev tolerate absence. See
     * `meta/operations.md` (Staging Access Control) and the `void-staging-programmatic`
     * service token.
     */
    CF_ACCESS_CLIENT_ID_STAGING?: string;
    CF_ACCESS_CLIENT_SECRET_STAGING?: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    AUTH_REDIRECT_URI?: string;
    DEV_AUTH_BYPASS?: string;
    DISPATCH_NAMESPACE?: string;
    DISPATCH_WORKER_NAME?: string;
    /**
     * Name of the tail-consumer Worker that receives runtime logs (Tail Worker).
     * Wired into per-user-script `tail_consumers` metadata on each WfP upload
     * so user scripts have explicit, belt-and-suspenders log fan-out in
     * addition to the dispatch worker's namespace-wide propagation.
     * Falls back to `void-tail` when unset.
     */
    TAIL_SERVICE_NAME?: string;
    VOID_PROXY_SERVICE?: string;
    VOID_PROXY_TOKEN?: string;
    /**
     * Name of the Cloudflare Queue (e.g. `void-usage-events` /
     * `void-usage-events-staging`) injected as a producer binding on user
     * worker uploads that declare a sandbox (`manifest.sandbox`). The
     * framework runtime publishes container-runtime metering messages to
     * the `USAGE_EVENTS_QUEUE` binding; the API itself consumes the same
     * queue. Falls back to `void-usage-events` when unset.
     */
    USAGE_EVENTS_QUEUE_NAME?: string;
    SITE_DOMAIN?: string;
    DASHBOARD_URL?: string;
    USAGE_COUNTER: DurableObjectNamespace;
    CRON_SCHEDULER: DurableObjectNamespace;
    ERROR_ALERT_MONITOR: DurableObjectNamespace;
    SANDBOX_CONCURRENCY_COUNTER: DurableObjectNamespace<SandboxConcurrencyCounter>;
    /**
     * Singleton DO that queues `executor='container'` builds and enforces
     * per-user tier concurrency before handing each build to a BuildManager.
     */
    BUILD_SCHEDULER: DurableObjectNamespace;
    /**
     * Per-build DO (keyed by build id) that runs the build container, streams
     * logs, and writes status transitions back to Postgres. The base (free)
     * size: `standard-3` = 2 vCPU / 8 GiB / 16 GB.
     */
    BUILD_MANAGER: DurableObjectNamespace;
    /**
     * Larger per-build DO for paid plans — same `BuildManager` behavior, but a
     * distinct container-enabled DO class bound to a bigger static
     * `instance_type` (standard-4). `@cloudflare/containers` has no per-start
     * sizing, so a second class is the only way to offer a second size.
     * `buildManagerNamespace` picks between this and `BUILD_MANAGER` by the
     * build's persisted instance_type.
     */
    BUILD_MANAGER_LARGE: DurableObjectNamespace;
    /**
     * Producer for the cron-firing queue. Used by `CronScheduler.alarm()` to
     * enqueue user-worker invocations from inside its Durable Object context.
     * The queue handler in `cron-fires-queue.ts` is what actually calls
     * `env.DISPATCH.get(...).fetch(...)` — see the comment in that file for
     * why the DO can't make the call directly.
     */
    CRON_FIRES_QUEUE: Queue<import('./cron-fires-queue.ts').CronFireMessage>;
    LOGS_DATASET?: string;
    REQUESTS_DATASET?: string;
    PLATFORM_ENV?: string;
    PROJECT_SECRET_KEYS_JSON: string;
    PROJECT_SECRET_ACTIVE_KEY_VERSION: string;
    /**
     * R2 S3-compatible API credentials for presigning direct-to-R2 asset
     * uploads (see `src/r2-presign.ts` and the upload-urls deploy
     * endpoint). Set via `wrangler secret put` — never committed.
     */
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    /**
     * Bucket name used in the presigned R2 PUT URL path. The
     * `STATIC_ASSETS_R2` binding gives the platform an `R2Bucket` object
     * but doesn't surface its underlying bucket name (CF binds by name and
     * exposes only the bound object). The presigner needs the bucket name
     * to assemble `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`,
     * so we plumb it explicitly. Wrangler's `vars` block carries the same
     * string used in the `r2_buckets[].bucket_name` config.
     */
    R2_STATIC_ASSETS_BUCKET: string;
    EMAIL?: SendEmail;
    /**
     * Test-only override for the deploy handler's heartbeat interval in ms.
     * Falls back to 15_000 when undefined, falsy, or non-positive. Kept on
     * `ApiEnv` (rather than wiring a fresh plumbing path) so integration tests
     * can exercise the heartbeat timer without waiting 15 seconds per case.
     */
    DEPLOY_HEARTBEAT_INTERVAL_MS?: number;
  };
  Variables: {
    user: User;
    db: Db;
    /**
     * Project id a scoped deploy token is pinned to. Set by `authMiddleware`
     * for `aud:'deploy'` tokens; absent for full `aud:'api'` tokens. The deploy
     * endpoint guards on this so a deploy token can only deploy its own project.
     */
    deployScope?: string;
    /**
     * Build id a scoped deploy token is bound to. Set by `authMiddleware` for
     * `aud:'deploy'` tokens that carry a `build` claim; absent for full
     * `aud:'api'` tokens and legacy deploy tokens. The deploy endpoint rejects
     * the token once this build is no longer active (superseded/cancelled), so
     * a stale runner can't deploy an older commit after being superseded.
     */
    deployBuild?: string;
  };
};
