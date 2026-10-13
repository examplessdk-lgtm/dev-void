import { describe, expect, it } from 'vite-plus/test';
import { resolveWorkersAiBindingName, shouldBindWorkersAi } from '../../src/plugin-ai-setup.ts';

describe('shouldBindWorkersAi', () => {
  it("does not override a user's root-wrangler `ai` binding", () => {
    expect(shouldBindWorkersAi('build', true, { binding: 'X' }, undefined)).toBe(false);
  });
});

describe('resolveWorkersAiBindingName', () => {
  it('uses a custom inference binding name', () => {
    expect(resolveWorkersAiBindingName(undefined, 'MY_AI')).toBe('MY_AI');
  });

  it('preserves a root Wrangler binding over the inference name', () => {
    expect(resolveWorkersAiBindingName({ binding: 'ROOT_AI' }, 'MY_AI')).toBe('ROOT_AI');
  });
});
