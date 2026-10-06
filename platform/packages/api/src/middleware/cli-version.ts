import type { Context } from 'hono';

/**
 * Lowest void CLI version compatible with the current deploy wire format
 * (direct-to-R2 + JSON-mode finalize). Bump alongside any future
 * wire-protocol break that requires CLI cooperation.
 *
 * Sourced from the framework `void` package on npm. 0.7.0 was the first
 * release shipping the direct-to-R2 path; everything earlier sent the
 * removed multipart body.
 */
export const MIN_CLI_VERSION = '0.7.0';

// SemVer 2.0 with optional prerelease (`-...`) and/or build metadata (`+...`).
// Both suffixes must be `[\w.-]+` (word chars, dots, hyphens). The build
// metadata branch matters because CI-built CLIs commonly stamp commit
// SHAs as `1.2.3+sha.abcdef` — without `+...` support, those would be
// rejected by the fail-closed gate even though they're newer than MIN.
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

function parseSemver(version: string): [number, number, number] | null {
  const match = SEMVER_RE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Compare two `MAJOR.MINOR.PATCH` strings. Pre-release suffixes are
 * ignored — `0.7.0-rc.1` compares equal to `0.7.0` for gate purposes,
 * which is fine because we only need MIN-coverage decisions, not
 * SemVer-correct ordering.
 *
 * Returns `null` if either string fails to parse. Callers must decide
 * how to interpret null — for `cliVersionStatus` below, an unparseable
 * *client-supplied* version fails closed (treated as a stale CLI), but
 * an unparseable MIN_CLI_VERSION would be a bug we want to surface, so
 * `null` propagates upward.
 */
export function compareVersions(leftVersion: string, rightVersion: string): number | null {
  const leftParts = parseSemver(leftVersion);
  const rightParts = parseSemver(rightVersion);
  if (!leftParts || !rightParts) {
    return null;
  }
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

export type CliOutdatedBody = Readonly<{
  error: 'cli_outdated';
  message: string;
  minVersion: string;
  clientVersion?: string;
}>;

/**
 * Returns a 426 response if the request comes from a stale CLI; `null`
 * otherwise. Two-layer check, both running in this single helper:
 *
 *   1. Content-Type sniff — any `multipart/*` request body is a marker
 *      of a pre-direct-to-R2 CLI. The new handlers can't parse multipart
 *      and would otherwise return an opaque "invalid JSON body" 400.
 *
 *   2. `X-Void-CLI-Version` header policy:
 *      - present, parses, ≥ MIN_CLI_VERSION → pass (`null`)
 *      - present, parses, < MIN_CLI_VERSION → 426 cli_outdated
 *      - present, *unparseable* → 426 cli_outdated (FAIL CLOSED — anything
 *        the regex rejects is either a buggy CLI we should surface or a
 *        forged bypass attempt; pre-release tags are explicitly allowed
 *        by the regex, so legitimate CLIs won't hit this path)
 *      - missing → pass (`null`) — pre-header CLIs that already speak
 *        the JSON wire format (void@0.7.0 / 0.7.1) ship without this
 *        header; rejecting "missing" today would brick them.
 *
 * **Migration policy for missing headers:** This is a permanent
 * pass-through, NOT a temporary one. The downstream wire checks
 * (manifest.version, assetManifestVersion) only enforce
 * `MIN_CLI_VERSION` when a future breaking change happens to break
 * those exact fields. A wire change that does NOT bump
 * `manifest.version` (e.g., a new required field on `assets[]`, a new
 * endpoint, a renamed JSON key on /upload-urls) would slip past for
 * pre-header clients. If a future ratchet needs to reject *every*
 * pre-header client, introduce a separate constant
 * (`REQUIRE_CLI_VERSION_HEADER_FROM = "0.X.0"`) and reject missing
 * headers when that knob is set. Do not silently re-purpose
 * `MIN_CLI_VERSION` for that — the missing-header path here is
 * deliberately exempt and any change to that should be loud.
 *
 * **Call site contract:** handlers MUST call this AFTER project load +
 * ownership + status checks, so a stale-CLI request hitting a missing /
 * foreign / deleting project still gets the more specific 404 / 403 /
 * 410 first. The multipart sniff is body-content-free (header only) so
 * delaying it past project lookup is safe.
 */
export function checkCliVersionOrRespond(context: Context): Response | null {
  const contentType = context.req.header('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('multipart/')) {
    const body: CliOutdatedBody = {
      error: 'cli_outdated',
      message:
        'Your void CLI is too old: it sent a multipart deploy body, which is no longer supported. ' +
        `Upgrade with: npm i -g void@latest (minimum version ${MIN_CLI_VERSION}).`,
      minVersion: MIN_CLI_VERSION,
    };
    return context.json(body, 426);
  }

  const cliVersion = context.req.header('x-void-cli-version');
  if (cliVersion !== undefined) {
    const cmp = compareVersions(cliVersion, MIN_CLI_VERSION);
    if (cmp === null || cmp < 0) {
      const body: CliOutdatedBody = {
        error: 'cli_outdated',
        message:
          cmp === null
            ? `Your void CLI sent an unrecognized version "${cliVersion}". ` +
              'Upgrade with: npm i -g void@latest'
            : `Your void CLI ${cliVersion} is below the minimum supported version ${MIN_CLI_VERSION}. ` +
              'Upgrade with: npm i -g void@latest',
        minVersion: MIN_CLI_VERSION,
        clientVersion: cliVersion,
      };
      return context.json(body, 426);
    }
  }

  return null;
}
