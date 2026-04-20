import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
// Import the handler module so the prototype patch is applied as a side effect.
import '../../src/runtime/handler';

/**
 * The `c.rewrite` type augmentation in `runtime/handler.ts` is project-wide.
 * Any Hono Context in the dep graph types `c.rewrite` as available, but at
 * runtime it's only attached per-instance by Void's compiled middleware. To
 * avoid `TypeError: c.rewrite is not a function` on contexts that didn't flow
 * through Void's router (vanilla Hono apps, mounted sub-apps, third-party
 * middleware), the runtime installs a default `Context.prototype.rewrite`
 * that throws a clear, actionable error.
 *
 * These tests verify both halves of that contract:
 *   1) The fallback throws a recognisable error mentioning `voidPlugin`.
 *   2) Per-instance assignment (what compile.ts emits) still wins, so managed
 *      requests get the real implementation without any prototype interference.
 */
describe('Context.prototype.rewrite fallback', () => {
  it('throws a clear error mentioning voidPlugin when invoked on an unmanaged Context', async () => {
    const app = new Hono();
    let captured: Error | undefined;
    app.get('/test', (c) => {
      try {
        // This is exactly the failure mode we want to surface: a vanilla
        // Hono app whose Context never went through Void's middleware.
        (c as unknown as { rewrite: (p: string) => unknown }).rewrite('/foo');
      } catch (err) {
        captured = err as Error;
      }
      return c.text('ok');
    });

    const res = await app.request('http://localhost/test');
    expect(res.status).toBe(200);
    expect(captured).toBeInstanceOf(Error);
    expect(captured?.message).toContain('voidPlugin');
    expect(captured?.message).toContain('c.rewrite()');
  });

  it('allows per-instance assignment to override the prototype default', async () => {
    const app = new Hono();
    const sentinel = new Response('rewritten', { status: 299 });
    let resultFromRewrite: unknown;

    app.get('/test', (c) => {
      // Mirror compile.ts: `c.rewrite = (path) => { … }`. With the prototype
      // property defined as writable+configurable this plain assignment must
      // simply shadow the default — no TypeError.
      (c as unknown as { rewrite: (p: string) => Response }).rewrite = (_path: string) => sentinel;
      resultFromRewrite = (c as unknown as { rewrite: (p: string) => unknown }).rewrite(
        '/somewhere',
      );
      return c.text('ok');
    });

    const res = await app.request('http://localhost/test');
    expect(res.status).toBe(200);
    expect(resultFromRewrite).toBe(sentinel);
  });
});
