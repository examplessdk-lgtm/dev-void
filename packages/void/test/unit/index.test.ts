import { describe, expect, it } from 'vite-plus/test';
import { resolveWorkersAiBindingName, shouldBindWorkersAi } from '../../src/index.ts';

// `shouldBindWorkersAi(command, needsAI, resolvedAi, resultAi)` is the pure,
// testable surface of the self-host serve-gate (the surrounding `mergeBindings`
// is an unexported closure). It decides whether the built wrangler config gets
// an injected Workers AI binding. Assert the real return values.
describe('shouldBindWorkersAi', () => {
  it('never binds Workers AI during dev/serve (miniflare has no local AI)', () => {
    // Dev uses the P2 `__VOID_TOKEN` proxy path instead of `env.AI`.
    expect(shouldBindWorkersAi('serve', true, undefined, undefined)).toBe(false);
  });

  it('binds Workers AI on a self-host build when the app uses AI', () => {
    expect(shouldBindWorkersAi('build', true, undefined, undefined)).toBe(true);
  });

  it("does not override a user's root-wrangler `ai` binding", () => {
    // A resolved root-wrangler `ai` binding wins — never clobber it.
    expect(shouldBindWorkersAi('build', true, { binding: 'X' }, undefined)).toBe(false);
  });

  it('does not bind Workers AI when the app does not use AI', () => {
    expect(shouldBindWorkersAi('build', false, undefined, undefined)).toBe(false);
  });
});

describe('resolveWorkersAiBindingName', () => {
  it('uses a custom inference binding name', () => {
    expect(resolveWorkersAiBindingName(undefined, 'MY_AI')).toBe('MY_AI');
  });

  it('preserves a root Wrangler binding over the inference name', () => {
    expect(resolveWorkersAiBindingName({ binding: 'ROOT_AI' }, 'MY_AI')).toBe('ROOT_AI');
  });

  it('defaults to AI', () => {
    expect(resolveWorkersAiBindingName(undefined)).toBe('AI');
  });
});
