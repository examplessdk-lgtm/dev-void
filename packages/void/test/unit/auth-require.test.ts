import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { requireAuth, type AuthUser } from '../../src/runtime/auth';

function mockContext(user: AuthUser | null) {
  return {
    get(key: string) {
      if (key === 'user') {
        return user;
      }
      return undefined;
    },
  } as any;
}

describe('requireAuth', () => {
  it('returns user when present', () => {
    const user: AuthUser = {
      id: 'u1',
      createdAt: new Date('2026-03-09T00:00:00Z'),
      updatedAt: new Date('2026-03-09T00:00:00Z'),
      email: 'test@test.com',
      emailVerified: true,
      name: 'Test',
      image: null,
    };
    expect(requireAuth(mockContext(user))).toBe(user);
  });

  it('throws HTTPException 401 when user is null', () => {
    expect(() => requireAuth(mockContext(null))).toThrow(HTTPException);
    expect(() => requireAuth(mockContext(null))).toThrow('Unauthorized');
  });
});
