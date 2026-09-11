import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { WRANGLER_EMAIL_PROSE_VERSION } from '../../src/cli/email-cloudflare.ts';
import { resolveWranglerArgv } from '../../src/cli/preset.ts';

const TMP = join(import.meta.dirname, '.tmp-wrangler-pin');

/**
 * The oldest wrangler whose `wrangler deploy` reconciles Email Routing rules from a
 * top-level `addresses` array (CHANGELOG 4.112.0 #14470 + 4.113.0 #14471). Older
 * wranglers pass the array through as an unknown key and never touch a rule.
 */
const MIN_EMAIL_ROUTING_WRANGLER = [4, 113, 0] as const;

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    throw new Error(`unparsable wrangler version ${JSON.stringify(version)}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

// The pinned wrangler — the ONE the deploy runner spawns — is the exact package
// `resolveWranglerArgv` resolves relative to `preset.ts` (void's own dependency, never
// an app-root wrangler), so read the manifest and bundle from that resolved entry rather
// than from a second, possibly different, resolution. Same idea as the platform's
// `PINNED_VOID_CLI_VERSION` test: a "keep in sync" comment does not hold, an assertion does.
describe('pinned wrangler (email-feature capability contract)', () => {
  let root: string;
  let cliEntry: string;
  let wranglerPkg: { version: string };

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    root = join(TMP, 'app');
    mkdirSync(root, { recursive: true });
    // An app root with NO wrangler of its own — strict pnpm — so only void's module
    // resolution can satisfy the launcher.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    const argv = resolveWranglerArgv(root);
    cliEntry = argv[argv.length - 1];
    wranglerPkg = JSON.parse(
      readFileSync(join(dirname(dirname(cliEntry)), 'package.json'), 'utf-8'),
    ) as { version: string };
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('resolves the real wrangler-dist/cli.js of a wrangler >= 4.113.0', () => {
    expect(cliEntry.replace(/\\/g, '/')).toMatch(/\/wrangler\/wrangler-dist\/cli\.js$/);
    expect(
      compareSemver(parseSemver(wranglerPkg.version), MIN_EMAIL_ROUTING_WRANGLER),
    ).toBeGreaterThanOrEqual(0);
  });

  it('is the exact wrangler the email prose parsers are pinned to', () => {
    // The `wrangler email` parsers read prose captured from ONE wrangler
    // (`test/fixtures/wrangler-email/<version>/`); the fixtures are static files, so a catalog
    // bump keeps every parser test green while the shipped prose may have moved. A parser miss
    // fails closed to `unknown — run void email setup` on every deploy, with nothing pointing at
    // the cause. When this fails: re-capture the fixtures for the new version (README there) and
    // move `WRANGLER_EMAIL_PROSE_VERSION`.
    expect(wranglerPkg.version).toBe(WRANGLER_EMAIL_PROSE_VERSION);
  });

  it('ships a `wrangler deploy` that applies top-level `addresses` (Email Routing plan)', () => {
    // The deploy path prints this heading while reconciling rules from `addresses`
    // (`applyEmailRoutingAddresses`); without it, a config carrying `addresses` deploys
    // the worker and silently creates no routing rule.
    const bundle = readFileSync(cliEntry, 'utf-8');
    expect(bundle).toContain('Email Routing plan:');
  });

  it('ships `wrangler auth token` (the session-bearer hand-off for the two REST-only steps)', () => {
    // `wrangler auth token --json` is the documented, stable way to borrow the login
    // session's bearer for the subdomain-routing and subaddressing calls wrangler has no
    // command for. It is registered as `authTokenCommand` in the bundle.
    const bundle = readFileSync(cliEntry, 'utf-8');
    expect(bundle).toContain('authTokenCommand');
  });
});
