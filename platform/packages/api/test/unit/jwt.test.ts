import { describe, it, expect, vi } from 'vite-plus/test';
import { signJwt, verifyJwt } from '../../src/auth/jwt.ts';

const SECRET = 'test-secret-key-for-jwt';

describe('JWT', () => {
  it('round-trip sign and verify returns correct payload', async () => {
    const token = await signJwt({ sub: 'user_abc123', login: 'octocat', aud: 'api' }, SECRET);
    const payload = await verifyJwt(token, SECRET);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user_abc123');
    expect(payload!.login).toBe('octocat');
    expect(payload!.iat).toBeTypeOf('number');
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it('returns null for expired token', async () => {
    // Mock Date.now to produce an expired token
    const realDateNow = Date.now;
    const pastMs = Date.now() - 31 * 24 * 60 * 60 * 1000; // 31 days ago
    vi.spyOn(Date, 'now').mockReturnValueOnce(pastMs);

    const token = await signJwt({ sub: 'user_abc123', login: 'octocat', aud: 'api' }, SECRET);

    // Restore real Date.now for verification
    Date.now = realDateNow;
    const payload = await verifyJwt(token, SECRET);

    expect(payload).toBeNull();
    vi.restoreAllMocks();
  });

  it('returns null for tampered token', async () => {
    const token = await signJwt({ sub: 'user_abc123', login: 'octocat', aud: 'api' }, SECRET);

    // Tamper with the payload
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;

    const payload = await verifyJwt(tampered, SECRET);
    expect(payload).toBeNull();
  });

  it('returns null for malformed string', async () => {
    expect(await verifyJwt('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyJwt('', SECRET)).toBeNull();
    expect(await verifyJwt('a.b', SECRET)).toBeNull();
  });

  it('returns null for wrong secret', async () => {
    const token = await signJwt({ sub: 'user_abc123', login: 'octocat', aud: 'api' }, SECRET);
    const payload = await verifyJwt(token, 'wrong-secret');
    expect(payload).toBeNull();
  });
});
