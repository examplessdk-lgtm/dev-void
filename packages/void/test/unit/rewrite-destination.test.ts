import { describe, expectTypeOf, it } from 'vitest';
import type { RewriteDestination, RouteName } from '../../src/routes-stub.ts';

/**
 * Type-level tests for RouteName / RewriteDestination on the `void/routes`
 * module (resolved to `routes-stub.ts` via tsconfig paths).
 *
 * Module augmentations via `declare module 'void/routes'` are project-wide,
 * so `RouteMap` here is whatever every test file in the compilation unit has
 * contributed (notably fetch.test.ts, which adds `/api/hello`, `/api/users`,
 * etc.). We use those known entries to assert autocomplete-style inference
 * while also verifying the `(string & {})` escape hatch still accepts any
 * string (needed for dynamic paths like `/users/${id}`).
 */

// Contribute a unique pattern so at least one route is guaranteed present
// regardless of which other test files share the project.
declare module 'void/routes' {
  interface RouteMap {
    '/rewrite-destination-test/known': {
      GET: { input: unknown; output: unknown };
    };
  }
}

describe('RewriteDestination', () => {
  it('includes generated route patterns as assignable literals', () => {
    expectTypeOf<'/rewrite-destination-test/known'>().toMatchTypeOf<RewriteDestination>();
  });

  it('still accepts arbitrary strings (dynamic path escape hatch)', () => {
    // This is what the `(string & {})` trick preserves — without it the
    // union would collapse to a literal-only type and reject dynamic paths.
    const dynamic: string = `/users/${42}`;
    expectTypeOf(dynamic).toMatchTypeOf<RewriteDestination>();
    expectTypeOf<'/totally/made/up'>().toMatchTypeOf<RewriteDestination>();
  });

  it('accepts any literal string type', () => {
    expectTypeOf<'/anything'>().toMatchTypeOf<RewriteDestination>();
    expectTypeOf<'/users/123'>().toMatchTypeOf<RewriteDestination>();
  });

  it('works as the value type of a Record<string, …>', () => {
    const rewrites: Record<string, RewriteDestination> = {
      '/old': '/new',
      '/legacy/*': '/v2/catchall',
      '/known': '/rewrite-destination-test/known',
    };
    expectTypeOf(rewrites).toMatchTypeOf<Record<string, string>>();
  });

  it('exposes known route names via RouteName', () => {
    expectTypeOf<'/rewrite-destination-test/known'>().toMatchTypeOf<RouteName>();
  });

  it('RewriteDestination is assignable to string', () => {
    expectTypeOf<RewriteDestination>().toMatchTypeOf<string>();
  });
});
