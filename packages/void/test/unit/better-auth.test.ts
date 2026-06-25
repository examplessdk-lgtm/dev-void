import { describe, expect, it } from 'vite-plus/test';
import { voidAuthPassword } from '../../src/runtime/better-auth-shared.ts';
import { resolveVoidAuthOptions } from '../../src/runtime/better-auth.ts';

describe('resolveVoidAuthOptions', () => {
  it('defaults to email auth when no providers are configured', async () => {
    const { options } = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
    });
    expect(options.socialProviders).toBeUndefined();
  });

  it('resolves configured social providers from standardized env vars', async () => {
    const { options } = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
        AUTH_DISCORD_CLIENT_ID: 'discord-id',
        AUTH_DISCORD_CLIENT_SECRET: 'discord-secret',
        AUTH_GITHUB_CLIENT_ID: 'github-id',
        AUTH_GITHUB_CLIENT_SECRET: 'github-secret',
      },
      {
        dialect: 'sqlite',
        providers: ['email', 'discord', 'github'],
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
    });
    expect(options.socialProviders).toEqual({
      discord: {
        clientId: 'discord-id',
        clientSecret: 'discord-secret',
      },
      github: {
        clientId: 'github-id',
        clientSecret: 'github-secret',
      },
    });
  });

  it('preserves the default password handler when email auth is customized', async () => {
    const { options } = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
        userConfig: {
          emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
          },
        },
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password: voidAuthPassword,
      requireEmailVerification: true,
    });
  });

  it('preserves a custom password handler when email auth is customized', async () => {
    const password = {
      async hash(value: string) {
        return `custom:${value}`;
      },
      async verify() {
        return true;
      },
    };

    const { options } = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {
        BETTER_AUTH_SECRET: 'secret',
      },
      {
        dialect: 'sqlite',
        providers: null,
        userConfig: {
          emailAndPassword: {
            enabled: true,
            password,
          },
        },
      },
      {} as never,
    );

    expect(options.emailAndPassword).toEqual({
      enabled: true,
      password,
    });
  });

  it('throws when a configured provider is missing env credentials', async () => {
    await expect(
      resolveVoidAuthOptions(
        new Request('https://example.com/api/auth'),
        {
          BETTER_AUTH_SECRET: 'secret',
        },
        {
          dialect: 'sqlite',
          providers: ['google'],
        },
        {} as never,
      ),
    ).rejects.toThrow("auth: Missing credentials for provider 'google'");
  });

  it('requires BETTER_AUTH_SECRET in production when none is set', async () => {
    await expect(
      resolveVoidAuthOptions(
        new Request('https://example.com/api/auth'),
        {
          AUTH_SECRET: 'legacy-secret',
        },
        {
          dialect: 'sqlite',
          providers: null,
        },
        {} as never,
      ),
    ).rejects.toThrow('auth: Missing Better Auth secret. Set BETTER_AUTH_SECRET.');
  });

  it('does not use the dev fallback secret for a spoofed localhost Host header in production', async () => {
    await expect(
      resolveVoidAuthOptions(
        new Request('http://localhost:3000/api/auth'),
        {},
        {
          dialect: 'sqlite',
          providers: null,
        },
        {} as never,
      ),
    ).rejects.toThrow('auth: Missing Better Auth secret. Set BETTER_AUTH_SECRET.');
  });

  it('uses the dev fallback secret only when running in dev and BETTER_AUTH_SECRET is missing', async () => {
    const { options } = await resolveVoidAuthOptions(
      new Request('https://example.com/api/auth'),
      {},
      {
        dialect: 'sqlite',
        providers: null,
        dev: true,
      },
      {} as never,
    );

    expect(options.secret).toBe('void-dev-better-auth-secret-1234567890');
  });

  it('uses a native scrypt password handler compatible with Better Auth hashes', async () => {
    const hash = await voidAuthPassword.hash('correct horse battery staple');

    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'correct horse battery staple',
      }),
    ).resolves.toBe(true);
    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'wrong password',
      }),
    ).resolves.toBe(false);
  });

  it('verifies existing Better Auth scrypt hashes', async () => {
    const hash =
      '0123456789abcdeffedcba9876543210:bb68a5c89332e634a98a2ca6f60e2d68861b64f1fa59446dd8669396e5b76a66059da52a9ce48b43bddfc319aceddf788125882ae27c395f90306cb47e8264ae';

    await expect(
      voidAuthPassword.verify({
        hash,
        password: 'correct horse battery staple',
      }),
    ).resolves.toBe(true);
  });

  it('treats unsupported password hash formats as invalid credentials', async () => {
    await expect(
      voidAuthPassword.verify({
        hash: 'sha256-pbkdf2:1000:salt:hash',
        password: 'password',
      }),
    ).resolves.toBe(false);
    await expect(
      voidAuthPassword.verify({
        hash: '0123456789abcdeffedcba9876543210:not-hex',
        password: 'password',
      }),
    ).resolves.toBe(false);
  });
});
