import { describe, expect, it } from 'vite-plus/test';
import {
  hasApiRoutes,
  hasDocumentRoutes,
  resolveAssetConfig,
  resolveAssetRoutingPolicy,
  workerOwnsHtmlRouting,
} from '../../src/asset-routing.ts';

// `not_found_handling: 'none'` → asset binding 404s on unmatched paths,
// worker (run_worker_first) owns HTML responses.
//
// `not_found_handling: 'single-page-application'` → CF shortcuts browser
// navigations to the SPA shell before the worker runs. Acceptable when the
// worker does not need to inspect document navigations.
describe('resolveAssetConfig', () => {
  const NONE = { not_found_handling: 'none' as const, run_worker_first: ['/**'] };
  const SPA = {
    not_found_handling: 'single-page-application' as const,
    run_worker_first: ['/__void', '/__void/*'],
  };
  const SPA_API = {
    not_found_handling: 'single-page-application' as const,
    run_worker_first: ['/api', '/api/*', '/__void', '/__void/*'],
  };

  it('uses none when SSR is enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: true,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('uses none when pages mode is enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('keeps SPA handling when the project only has API routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(SPA_API);
  });

  it('routes the /__void internal namespace to the worker for SPA + API apps', () => {
    // Regression: a SPA app with API routes + D1 migrations lands in the
    // apiWorkerFirst branch. Without /__void in run_worker_first, CF Static
    // Assets serves index.html for GET /__void/migrate/capabilities before the
    // worker runs, so the migration handler is never reached and the deploy
    // fails with "migration protocol v2 capability negotiation failed".
    const config = resolveAssetConfig({
      isSsr: false,
      hasPages: false,
      hasApiRoutes: true,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    });
    expect(config.not_found_handling).toBe('single-page-application');
    expect(config.run_worker_first).toContain('/__void');
    expect(config.run_worker_first).toContain('/__void/*');
  });

  it('routes the /__void internal namespace worker-first for auth-enabled SPA apps', () => {
    // authEnabled also triggers the apiWorkerFirst branch (auth apps have
    // migrations for the auth tables), so /__void must reach the worker too.
    const config = resolveAssetConfig({
      isSsr: false,
      hasPages: false,
      hasApiRoutes: false,
      hasDocumentRoutes: false,
      hasMiddleware: false,
      authEnabled: true,
    });
    expect(config.run_worker_first).toContain('/__void/*');
  });

  it('routes the /__void internal namespace worker-first for a migration-only SPA (cron/queue app, no API/auth/pages)', () => {
    // A SPA whose only server code is a cron/queue handler still advertises
    // manifest.migrations (validatedMigrations is passed to buildVoidManifest
    // independently of routes), but has none of the asset-routing flags, so it
    // falls to the pure-SPA branch. Without /__void there, CF serves index.html
    // for GET /__void/migrate/capabilities and negotiation fails. (Codex #250 P2)
    const config = resolveAssetConfig({
      isSsr: false,
      hasPages: false,
      hasApiRoutes: false,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    });
    expect(config.not_found_handling).toBe('single-page-application');
    expect(config.run_worker_first).toContain('/__void');
    expect(config.run_worker_first).toContain('/__void/*');
  });

  it('uses none when the project has document routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: true,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('uses none when the project has middleware/', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: true,
      }),
    ).toEqual(NONE);
  });

  it('uses none when the project has document websocket routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        hasWebSockets: true,
      }),
    ).toEqual(NONE);
  });

  it('keeps SPA handling when the project only has API websocket routes', () => {
    const routes = [{ pattern: '/api/chat' }];
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: hasApiRoutes(routes),
        hasDocumentRoutes: false,
        hasMiddleware: false,
        hasWebSockets: hasDocumentRoutes(routes),
      }),
    ).toEqual(SPA_API);
  });

  it('routes managed auth endpoints through the worker without owning all HTML', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        authEnabled: true,
      }),
    ).toEqual(SPA_API);
  });

  it('uses none for the common SPA + auth-middleware shape', () => {
    // Regression: this is the case the SPA-fallback shortcut silently
    // breaks. Browser navigation to /api/auth/callback/google would arrive
    // with Sec-Fetch-Mode: navigate, get the SPA shell, and never reach
    // Better Auth — leaving the user "signed in" without a session cookie.
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: true,
      }),
    ).toEqual(NONE);
  });

  it('uses none when live bindings are enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        liveEnabled: true,
      }),
    ).toEqual(NONE);
  });

  it('uses single-page-application when no HTML-owning backend code is present', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(SPA);
  });

  it('classifies /api routes separately from document routes', () => {
    const apiRoutes = [
      { pattern: '/api' },
      { pattern: '/api/hello' },
      { pattern: '/api/users/:id' },
    ];
    expect(hasDocumentRoutes(apiRoutes)).toBe(false);
    expect(hasApiRoutes(apiRoutes)).toBe(true);

    expect(hasDocumentRoutes([{ pattern: '/hello' }])).toBe(true);
    expect(hasDocumentRoutes([{ pattern: '/apiish' }])).toBe(true);
    expect(hasApiRoutes([{ pattern: '/hello' }, { pattern: '/apiish' }])).toBe(false);
  });

  it('uses the same worker-owned HTML decision as the asset config', () => {
    const inputs = {
      isSsr: false,
      hasPages: false,
      hasDocumentRoutes: true,
      hasMiddleware: false,
    };
    expect(workerOwnsHtmlRouting(inputs)).toBe(true);
    expect(resolveAssetConfig(inputs)).toEqual(NONE);
  });

  it('resolves the complete request trigger policy', () => {
    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: SPA,
      apiWorkerFirst: false,
      workerFirst: false,
      workerSpaFallback: false,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: true,
      }),
    ).toEqual({
      assetConfig: NONE,
      apiWorkerFirst: false,
      workerFirst: true,
      workerSpaFallback: true,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: SPA_API,
      apiWorkerFirst: true,
      workerFirst: false,
      workerSpaFallback: false,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: true,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: NONE,
      apiWorkerFirst: false,
      workerFirst: true,
      workerSpaFallback: false,
    });
  });
});

// `routing.notFound` (void.json) is an explicit escape hatch, not a new default.
//
// Without it, an app whose assets came from a static site generator and whose
// only backend is an API route takes the `apiWorkerFirst` branch, so unknown
// URLs are answered with `index.html` and HTTP **200**. The generator's real
// `404.html` is never served and crawlers see 200 for every URL. The default
// cannot change — a genuine SPA needs that fallback for deep links, and a built
// asset tree carries nothing that distinguishes the two — so the user says so.
//
// Only `not_found_handling` moves: `run_worker_first` and every derived flag
// stay as inferred, so which layer sees a request first is unaffected.
describe('resolveAssetRoutingPolicy — routing.notFound override', () => {
  const SPA_API_WORKER_FIRST = ['/api', '/api/*', '/__void', '/__void/*'];

  const ssgWithApi = {
    isSsr: false,
    hasPages: false,
    hasApiRoutes: true,
    hasDocumentRoutes: false,
    hasMiddleware: false,
  } as const;

  it('leaves the inferred SPA fallback in place when unset', () => {
    expect(resolveAssetRoutingPolicy(ssgWithApi).assetConfig).toEqual({
      not_found_handling: 'single-page-application',
      run_worker_first: SPA_API_WORKER_FIRST,
    });
  });

  it('serves a real 404 page when set to "404-page"', () => {
    expect(resolveAssetRoutingPolicy({ ...ssgWithApi, notFound: '404-page' }).assetConfig).toEqual({
      not_found_handling: '404-page',
      run_worker_first: SPA_API_WORKER_FIRST,
    });
  });

  it('leaves run_worker_first and the derived flags untouched', () => {
    const inferred = resolveAssetRoutingPolicy(ssgWithApi);
    const overridden = resolveAssetRoutingPolicy({ ...ssgWithApi, notFound: '404-page' });
    expect(overridden.assetConfig.run_worker_first).toEqual(inferred.assetConfig.run_worker_first);
    expect(overridden.apiWorkerFirst).toBe(inferred.apiWorkerFirst);
    expect(overridden.workerFirst).toBe(inferred.workerFirst);
    expect(overridden.workerSpaFallback).toBe(inferred.workerSpaFallback);
  });

  it('applies on the plain-asset branch too (no API routes)', () => {
    const inputs = {
      isSsr: false,
      hasPages: false,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    } as const;
    expect(resolveAssetRoutingPolicy({ ...inputs, notFound: 'none' }).assetConfig).toEqual({
      not_found_handling: 'none',
      run_worker_first: ['/__void', '/__void/*'],
    });
  });

  it('can also override the worker-first branch, which infers "none"', () => {
    const workerFirst = {
      isSsr: false,
      hasPages: true,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    } as const;
    expect(resolveAssetRoutingPolicy(workerFirst).assetConfig.not_found_handling).toBe('none');
    expect(resolveAssetRoutingPolicy({ ...workerFirst, notFound: '404-page' }).assetConfig).toEqual(
      {
        not_found_handling: '404-page',
        run_worker_first: ['/**'],
      },
    );
  });

  it('is reachable through resolveAssetConfig (the deploy entry point)', () => {
    expect(resolveAssetConfig({ ...ssgWithApi, notFound: '404-page' }).not_found_handling).toBe(
      '404-page',
    );
  });
});
