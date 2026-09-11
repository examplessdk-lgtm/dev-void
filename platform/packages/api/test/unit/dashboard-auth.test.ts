import { describe, expect, it, vi } from 'vite-plus/test';
import { authenticateDashboardToken } from '../../src/auth/dashboard.ts';
import { signJwt } from '../../src/auth/jwt.ts';

const SECRET = 'dashboard-test-secret';

function base64url(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('authenticateDashboardToken', () => {
  it('accepts a valid signed token', async () => {
    const token = await signJwt({ sub: 'user_123', login: 'octocat', aud: 'api' }, SECRET);
    const session = await authenticateDashboardToken(token, SECRET);

    expect(session).toEqual({
      token,
      user: {
        id: 'user_123',
        login: 'octocat',
      },
    });
  });

  it('rejects a forged token with arbitrary payload', async () => {
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ sub: 'user_123', login: 'attacker', exp: 9999999999 }));
    const forged = `${header}.${body}.fake-signature`;

    const session = await authenticateDashboardToken(forged, SECRET);
    expect(session).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const realDateNow = Date.now;
    const pastMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(pastMs);

    const token = await signJwt({ sub: 'user_123', login: 'octocat', aud: 'api' }, SECRET);

    Date.now = realDateNow;
    const session = await authenticateDashboardToken(token, SECRET);
    expect(session).toBeNull();
    vi.restoreAllMocks();
  });
});
