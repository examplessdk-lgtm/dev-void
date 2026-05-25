import { describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  react: vi.fn((options?: unknown) => ({ framework: 'react', options })),
  solid: vi.fn((options?: unknown) => ({ framework: 'solid', options })),
  svelte: vi.fn((options?: unknown) => ({ framework: 'svelte', options })),
  vue: vi.fn((options?: unknown) => ({ framework: 'vue', options })),
}));

vi.mock('better-auth/react', () => ({
  createAuthClient: mocks.react,
}));

vi.mock('better-auth/vue', () => ({
  createAuthClient: mocks.vue,
}));

vi.mock('better-auth/svelte', () => ({
  createAuthClient: mocks.svelte,
}));

vi.mock('better-auth/solid', () => ({
  createAuthClient: mocks.solid,
}));

import {
  auth as reactAuth,
  createAuthClient as createReactAuthClient,
} from '../../src/runtime/client-react.ts';
import {
  auth as solidAuth,
  createAuthClient as createSolidAuthClient,
} from '../../src/runtime/client-solid.ts';
import {
  auth as svelteAuth,
  createAuthClient as createSvelteAuthClient,
} from '../../src/runtime/client-svelte.ts';
import {
  auth as vueAuth,
  createAuthClient as createVueAuthClient,
} from '../../src/runtime/client-vue.ts';

describe('framework-specific client runtimes', () => {
  it('re-exports the React Better Auth client', () => {
    expect(createReactAuthClient).toBe(mocks.react);
    expect(mocks.react).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(reactAuth).toEqual({ framework: 'react', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Vue Better Auth client', () => {
    expect(createVueAuthClient).toBe(mocks.vue);
    expect(mocks.vue).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(vueAuth).toEqual({ framework: 'vue', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Svelte Better Auth client', () => {
    expect(createSvelteAuthClient).toBe(mocks.svelte);
    expect(mocks.svelte).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(svelteAuth).toEqual({ framework: 'svelte', options: { basePath: '/api/auth' } });
  });

  it('re-exports the Solid Better Auth client', () => {
    expect(createSolidAuthClient).toBe(mocks.solid);
    expect(mocks.solid).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(solidAuth).toEqual({ framework: 'solid', options: { basePath: '/api/auth' } });
  });
});
