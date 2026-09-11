import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vite-plus/test';
import { verifyGithubOidcToken } from '../../src/github/oidc-verify.ts';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const AUDIENCE = 'https://api.void.cloud';
const KID = 'test-key-1';

let privateKey: CryptoKey;
let publicKey: CryptoKey;

const baseClaims = {
  repository: 'octocat/hello-world',
  repository_owner: 'octocat',
  ref: 'refs/heads/main',
  sha: 'a'.repeat(40),
  run_id: '123456',
  workflow: 'void-deploy',
};

function sign(
  claims: Record<string, unknown>,
  opts?: { issuer?: string; audience?: string; expSeconds?: number },
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject('repo:octocat/hello-world:ref:refs/heads/main')
    .setIssuer(opts?.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${opts?.expSeconds ?? 600}s`);
  if (opts?.audience !== undefined) {
    builder.setAudience(opts.audience);
  }
  return builder.sign(privateKey);
}

describe('verifyGithubOidcToken', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    const jwks = { keys: [jwk] };

    // Serve the GitHub Actions JWKS from the stubbed fetch so the module-cached
    // remote JWKS set resolves our test public key (no network).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === JWKS_URL) {
          return new Response(JSON.stringify(jwks), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('verifies a valid token and returns claims', async () => {
    const token = await sign(baseClaims);
    const claims = await verifyGithubOidcToken(token);

    expect(claims).not.toBeNull();
    expect(claims!.repository).toBe('octocat/hello-world');
    expect(claims!.repository_owner).toBe('octocat');
    expect(claims!.ref).toBe('refs/heads/main');
    expect(claims!.sha).toBe('a'.repeat(40));
    expect(claims!.run_id).toBe('123456');
    expect(claims!.workflow).toBe('void-deploy');
  });

  it('enforces the audience when provided', async () => {
    const token = await sign(baseClaims, { audience: AUDIENCE });
    expect(await verifyGithubOidcToken(token, { audience: AUDIENCE })).not.toBeNull();
    expect(await verifyGithubOidcToken(token, { audience: 'https://evil.example' })).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = await sign(baseClaims, { expSeconds: -60 });
    expect(await verifyGithubOidcToken(token)).toBeNull();
  });

  it('returns null for a wrong issuer', async () => {
    const token = await sign(baseClaims, { issuer: 'https://evil.example' });
    expect(await verifyGithubOidcToken(token)).toBeNull();
  });

  it('returns null for a tampered token', async () => {
    // Mutating a few bytes of the real signature is PROBABILISTIC — an RS256
    // signature with ~1-2 flipped bytes still verifies for a small fraction of
    // keypairs (~0.3%), so `${sig.slice(0, -2)}AA` flaked. Splice in a signature
    // from a DIFFERENT key instead: the JWKS public key can never verify it, so
    // rejection is deterministic.
    const token = await sign(baseClaims);
    const foreign = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('600s')
      .sign(foreign.privateKey);
    const [header, payload] = token.split('.');
    const foreignSig = forged.split('.')[2];
    const tampered = `${header}.${payload}.${foreignSig}`;
    expect(await verifyGithubOidcToken(tampered)).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    expect(await verifyGithubOidcToken('not-a-jwt')).toBeNull();
    expect(await verifyGithubOidcToken('')).toBeNull();
  });
});
