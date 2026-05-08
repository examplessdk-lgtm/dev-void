import { describe, expect, it, vi } from 'vite-plus/test';

const { createAuthClientMock } = vi.hoisted(() => ({
  createAuthClientMock: vi.fn((options?: unknown) => ({ options })),
}));

vi.mock('better-auth/client', () => ({
  createAuthClient: createAuthClientMock,
}));

import { auth, createAuthClient } from '../../src/runtime/auth-client.ts';

describe('auth-client runtime', () => {
  it("re-exports Better Auth's createAuthClient", () => {
    expect(createAuthClient).toBe(createAuthClientMock);
  });

  it("creates the default auth client with Void's base path", () => {
    expect(createAuthClientMock).toHaveBeenCalledWith({ basePath: '/api/auth' });
    expect(auth).toEqual({ options: { basePath: '/api/auth' } });
  });
});
