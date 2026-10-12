import { describe, expectTypeOf, it } from 'vite-plus/test';
import type { RewriteDestination, RouteName } from '../../src/routes-stub.ts';

// `void/routes` resolves to routes-stub.ts; this augmentation adds a known route.
declare module 'void/routes' {
  interface RouteMap {
    '/rewrite-destination-test/known': {
      GET: { input: unknown; output: unknown };
    };
  }
}

describe('RewriteDestination', () => {
  it('still accepts arbitrary strings (dynamic path escape hatch)', () => {
    // This is what the `(string & {})` trick preserves — without it the
    // union would collapse to a literal-only type and reject dynamic paths.
    const dynamic: string = `/users/${42}`;
    expectTypeOf(dynamic).toMatchTypeOf<RewriteDestination>();
    expectTypeOf<'/totally/made/up'>().toMatchTypeOf<RewriteDestination>();
  });

  it('exposes known route names via RouteName', () => {
    expectTypeOf<'/rewrite-destination-test/known'>().toMatchTypeOf<RouteName>();
  });
});
