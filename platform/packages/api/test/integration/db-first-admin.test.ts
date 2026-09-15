import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createUserForPlatform } from '../../src/db.ts';
import { clearTables, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterAll(async () => {
  await teardownEnv();
});

describe('self-hosted first owner bootstrap', () => {
  it('atomically grants exactly the first self-hosted user admin access', async () => {
    const create = (id: string) =>
      env.db.transaction((tx) =>
        createUserForPlatform(
          tx as unknown as typeof env.db,
          'github',
          id,
          `user-${id}`,
          null,
          'installation-a1b2c3d4',
          { additionalSignupAllowed: true, bootstrapGitHubId: id },
        ),
      );
    const users = await Promise.all([create('one'), create('two')]);
    expect(users.filter((user) => user.role === 'admin')).toHaveLength(1);
    expect(users.filter((user) => user.role === 'user')).toHaveLength(1);
    expect(users.every((user) => user.plan === 'custom')).toBe(true);
  });

  it('allows only the configured GitHub identity to claim an empty installation', async () => {
    await expect(
      env.db.transaction((tx) =>
        createUserForPlatform(
          tx as unknown as typeof env.db,
          'github',
          'attacker',
          'attacker',
          null,
          'installation-a1b2c3d4',
          { additionalSignupAllowed: false, bootstrapGitHubId: 'owner-id' },
        ),
      ),
    ).rejects.toThrow('signup is restricted');
    const owner = await env.db.transaction((tx) =>
      createUserForPlatform(
        tx as unknown as typeof env.db,
        'github',
        'owner-id',
        'owner',
        null,
        'installation-a1b2c3d4',
        { additionalSignupAllowed: false, bootstrapGitHubId: 'owner-id' },
      ),
    );
    expect(owner.role).toBe('admin');
  });

  it('binds bootstrap ownership to the immutable GitHub account id', async () => {
    await expect(
      env.db.transaction((tx) =>
        createUserForPlatform(
          tx as unknown as typeof env.db,
          'github',
          'attacker-id',
          'owner',
          null,
          'installation-a1b2c3d4',
          { additionalSignupAllowed: false, bootstrapGitHubId: 'owner-id' },
        ),
      ),
    ).rejects.toThrow('signup is restricted');
    const renamedOwner = await env.db.transaction((tx) =>
      createUserForPlatform(
        tx as unknown as typeof env.db,
        'github',
        'owner-id',
        'renamed-owner',
        null,
        'installation-a1b2c3d4',
        { additionalSignupAllowed: false, bootstrapGitHubId: 'owner-id' },
      ),
    );
    expect(renamedOwner.role).toBe('admin');
  });

  it('preserves Void Cloud user defaults when no installation id is set', async () => {
    const user = await env.db.transaction((tx) =>
      createUserForPlatform(
        tx as unknown as typeof env.db,
        'github',
        'hosted',
        'hosted-user',
        null,
      ),
    );
    expect(user.role).toBe('user');
    expect(user.plan).toBe('free');
  });
});
