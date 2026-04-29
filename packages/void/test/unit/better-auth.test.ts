import { describe, expect, it } from 'vitest';
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

    expect(options.emailAndPassword).toEqual({ enabled: true });
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

    expect(options.emailAndPassword).toEqual({ enabled: true });
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

  it('requires BETTER_AUTH_SECRET outside localhost', async () => {
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

  it('uses the localhost fallback when BETTER_AUTH_SECRET is missing', async () => {
    const { options } = await resolveVoidAuthOptions(
      new Request('http://localhost:3000/api/auth'),
      {},
      {
        dialect: 'sqlite',
        providers: null,
      },
      {} as never,
    );

    expect(options.secret).toBe('void-dev-better-auth-secret-1234567890');
  });
});
