import { describe, expect, it } from 'vitest';
import { resolveAssetConfig } from '../../src/cli/deploy.ts';

// `not_found_handling: 'none'` → asset binding 404s on unmatched paths,
// worker (run_worker_first) owns HTML responses.
//
// `not_found_handling: 'single-page-application'` → CF shortcuts browser
// navigations to the SPA shell before the worker runs. Acceptable only for
// pure SPAs with no backend code.
describe('resolveAssetConfig', () => {
  const NONE = { not_found_handling: 'none' as const };
  const SPA = { not_found_handling: 'single-page-application' as const };

  it('uses none when SSR is enabled', () => {
    expect(
      resolveAssetConfig({ isSsr: true, hasPages: false, hasRoutes: false, hasMiddleware: false }),
    ).toEqual(NONE);
  });

  it('uses none when pages mode is enabled', () => {
    expect(
      resolveAssetConfig({ isSsr: false, hasPages: true, hasRoutes: false, hasMiddleware: false }),
    ).toEqual(NONE);
  });

  it('uses none when the project has routes/', () => {
    expect(
      resolveAssetConfig({ isSsr: false, hasPages: false, hasRoutes: true, hasMiddleware: false }),
    ).toEqual(NONE);
  });

  it('uses none when the project has middleware/', () => {
    expect(
      resolveAssetConfig({ isSsr: false, hasPages: false, hasRoutes: false, hasMiddleware: true }),
    ).toEqual(NONE);
  });

  it('uses none when the project has websocket routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasRoutes: false,
        hasMiddleware: false,
        hasWebSockets: true,
      }),
    ).toEqual(NONE);
  });

  it('uses none when managed auth is enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasRoutes: false,
        hasMiddleware: false,
        authEnabled: true,
      }),
    ).toEqual(NONE);
  });

  it('uses none for the common SPA + auth-middleware shape', () => {
    // Regression: this is the case the SPA-fallback shortcut silently
    // breaks. Browser navigation to /api/auth/callback/google would arrive
    // with Sec-Fetch-Mode: navigate, get the SPA shell, and never reach
    // Better Auth — leaving the user "signed in" without a session cookie.
    expect(
      resolveAssetConfig({ isSsr: false, hasPages: false, hasRoutes: true, hasMiddleware: true }),
    ).toEqual(NONE);
  });

  it('uses single-page-application only when no backend code is present', () => {
    expect(
      resolveAssetConfig({ isSsr: false, hasPages: false, hasRoutes: false, hasMiddleware: false }),
    ).toEqual(SPA);
  });
});
