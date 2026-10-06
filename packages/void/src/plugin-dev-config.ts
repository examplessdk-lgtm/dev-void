import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'pathslash';
import type { ViteDevServer } from 'vite';
import { voidWarn } from './log.ts';

/** Run `fn` shortly after Vite prints "ready" so dev messages stay visible. */
export function afterServerReady(server: ViteDevServer, fn: () => void): void {
  if (server.httpServer) {
    server.httpServer.once('listening', () => setTimeout(fn, 100));
  } else {
    fn();
  }
}

/**
 * Best-effort detection of `vite build` (and `vite preview`) so we can skip
 * dev-only side effects — writing the dev-trigger token and the dispatch
 * file — when no dev server will run. Vite's CLI passes the subcommand as
 * `process.argv[2]`; programmatic API users (and `vite` with no subcommand)
 * default to `dev`, which we detect as the absence of a build-shaped first
 * positional. This is intentionally permissive: when in doubt, we behave as
 * if we're in dev so first-request correctness is preserved.
 */
export function isViteBuildOrPreview(): boolean {
  const subcommand = process.argv[2];
  return subcommand === 'build' || subcommand === 'preview';
}

const DEV_TRIGGER_TOKEN_FILE_MODE = 0o600;

/**
 * Persist the dev-trigger token at `<root>/.void/dev-trigger-token` so
 * every voidPlugin() invocation against the same project reads the same
 * value. This matters because `@cloudflare/vite-plugin` spawns a
 * worker-environment child Vite that re-imports vite.config.ts and calls
 * voidPlugin() again — without persistence the parent and child would
 * generate different UUIDs, the dispatch file would embed one and the
 * hint plugin would print the other, and curls would land on
 * `unauthorized`.
 *
 * The file persists across dev sessions and deploys so saved curl scripts
 * keep working. It lives under `.void/` (gitignored) and is safe to remove.
 *
 * The file is owner-only (0600). It is the one credential the dev-inbox
 * routes accept, and loopback is reachable by every account on the host,
 * so a default-umask 0644 file would hand any other local user the raw MIME,
 * the DELETE, and the capture endpoint. A file persisted by an earlier
 * release is tightened in place, never rotated. Windows has no group/other
 * bits — `mode` and `chmod` only toggle write there — so it is left alone.
 */
export function getOrCreateDevTriggerToken(root: string): string {
  const tokenPath = join(root, '.void', 'dev-trigger-token');
  const readExisting = (): string | undefined => {
    try {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      return existing.length > 0 ? existing : undefined;
    } catch {
      return undefined;
    }
  };
  // Best-effort: a token we can read but not chmod (foreign owner, read-only
  // mount) must still start the dev server.
  const tightenExisting = (): void => {
    if (process.platform === 'win32') {
      return;
    }
    try {
      if ((statSync(tokenPath).mode & 0o077) !== 0) {
        chmodSync(tokenPath, DEV_TRIGGER_TOKEN_FILE_MODE);
      }
    } catch {
      // ignore
    }
  };

  const existing = readExisting();
  if (existing) {
    tightenExisting();
    return existing;
  }

  // Atomic create — `wx` fails with EEXIST if the file appeared between the
  // read above and the write below (parent + child Vite both racing). On
  // EEXIST we re-read the winner's token and use that, so both processes
  // converge on the same UUID.
  mkdirSync(join(root, '.void'), { recursive: true });
  const fresh = crypto.randomUUID();
  try {
    const fd = openSync(tokenPath, 'wx', DEV_TRIGGER_TOKEN_FILE_MODE);
    try {
      writeSync(fd, fresh);
    } finally {
      closeSync(fd);
    }
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    const winner = readExisting();
    if (winner) {
      return winner;
    }
    // EEXIST but file is empty — extreme edge case (interrupted writer).
    // Fall through and accept the fresh UUID; subsequent reads will win.
    return fresh;
  }
}

/**
 * Warn when the project's `package.json` does not declare `"type": "module"`.
 *
 * Vite's default `configLoader: "bundle"` bundles `vite.config.ts`,
 * externalizes deps, and then loads the bundle. When `package.json` is non-ESM
 * the bundle is written as `.js` and loaded via CJS `require()`, which throws
 * `ERR_REQUIRE_ASYNC_MODULE` if any externalized dep's ESM graph contains
 * top-level await. `@cloudflare/vite-plugin` (which voidPlugin pulls in) has
 * exactly such a TLA, so non-ESM consumers hit this on every Vite invocation.
 *
 * Runs once per Vite process (factory time), single sync read.
 */
export function warnIfPackageJsonIsNotEsm(root: string): void {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    return;
  }
  let pkg: { type?: unknown };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return;
  }
  if (pkg.type === 'module') {
    return;
  }
  voidWarn(
    'package.json is missing `"type": "module"`. Vite\'s default config loader ' +
      'will fail with ERR_REQUIRE_ASYNC_MODULE on transitive top-level await ' +
      '(e.g. @cloudflare/vite-plugin). Add `"type": "module"` to package.json, ' +
      'or run vite build with `--configLoader runner`.',
  );
}
