import { describe, expect, it } from 'vite-plus/test';
import { hasNonPageBackend } from '../../src/cli/deploy-helpers.ts';

const NONE = {
  hasRoutes: false,
  hasMiddleware: false,
  hasWebSockets: false,
  hasEmail: false,
  authEnabled: false,
  hasLive: false,
} as const;

describe('hasNonPageBackend', () => {
  it('is false when pages are the only surface', () => {
    expect(hasNonPageBackend({ ...NONE })).toBe(false);
  });

  it.each([
    ['hasRoutes'],
    ['hasMiddleware'],
    ['hasWebSockets'],
    ['hasEmail'],
    ['authEnabled'],
    ['hasLive'],
  ] as const)('is true when %s is the only surface', (key) => {
    expect(hasNonPageBackend({ ...NONE, [key]: true })).toBe(true);
  });

  // An `email/` handler compiles to the worker's `email()` export. The
  // static-site path uploads no worker at all, so taking it would drop every
  // inbound handler and bounce the mail with no error at deploy time.
  it('keeps an email-only project on the worker path', () => {
    expect(hasNonPageBackend({ ...NONE, hasEmail: true })).toBe(true);
  });
});
