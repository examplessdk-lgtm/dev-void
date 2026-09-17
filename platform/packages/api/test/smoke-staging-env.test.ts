import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vite-plus/test';
import { initializeStagingEnv } from '../../../scripts/kitchen-sink-staging-env-setup.ts';

function apiError(status: number, body: unknown) {
  return Object.assign(new Error('Failed to set secret'), {
    name: 'PlatformApiError',
    status,
    body: JSON.stringify(body),
  });
}

function fixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const project = {
    id: 'proj_staging_fixture',
    slug: 'kitchen-sink',
    user_id: 'test',
    type: 'app',
    created_at: '',
    custom_domain: null,
  };
  const client = {
    apiUrl: 'https://api.staging.void.cloud',
    listProjects: vi.fn(async () => [project]),
    listSecrets: vi.fn(async (_projectId: string) => [...values.keys()].map((name) => ({ name }))),
    setSecret: vi.fn(async (_projectId: string, name: string, value: string) => {
      values.set(name, value);
      return { ok: true, name };
    }),
  };
  return { client, values, project };
}

describe('staging kitchen-sink fixture env', () => {
  it('validates the whole batch before writing only the three required fixture values', async () => {
    const { client, values } = fixture();
    const validate = vi.fn(async () => {
      expect(client.setSecret).not.toHaveBeenCalled();
    });
    expect(await initializeStagingEnv(client, validate)).toEqual([
      'APP_NAME',
      'SECRET_KEY',
      'API_URL',
    ]);
    expect(validate).toHaveBeenCalledOnce();
    expect(values.get('APP_NAME')).toBe('Kitchen Sink');
    expect(values.get('API_URL')).toBe('https://api.example.com');
    expect(values.get('SECRET_KEY')).toMatch(/^[a-f0-9]{64}$/);
    expect(client.listSecrets).toHaveBeenCalledWith('proj_staging_fixture');
    expect(client.setSecret.mock.calls.every(([id]) => id === 'proj_staging_fixture')).toBe(true);
  });

  it('preserves existing values and never rotates the secret on repeat runs', async () => {
    const { client, values } = fixture({ SECRET_KEY: 'existing', OTHER: 'untouched' });
    const validate = vi.fn(async () => {});
    expect(await initializeStagingEnv(client, validate)).toEqual(['APP_NAME', 'API_URL']);
    expect(values.get('SECRET_KEY')).toBe('existing');
    expect(values.get('OTHER')).toBe('untouched');
    expect(client.setSecret).toHaveBeenCalledTimes(2);
    expect(await initializeStagingEnv(client, validate)).toEqual([]);
    expect(client.setSecret).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledOnce();
  });

  it('does not treat an existing empty value as missing', async () => {
    const { client, values } = fixture({ APP_NAME: '', SECRET_KEY: '', API_URL: '' });
    expect(await initializeStagingEnv(client, async () => {})).toEqual([]);
    expect(client.setSecret).not.toHaveBeenCalled();
    expect(values.get('SECRET_KEY')).toBe('');
  });

  it('rejects a non-staging API before even listing projects', async () => {
    const { client } = fixture();
    client.apiUrl = 'https://api.void.cloud';
    await expect(initializeStagingEnv(client, async () => {})).rejects.toThrow(
      'requires the staging API',
    );
    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.setSecret).not.toHaveBeenCalled();
  });

  it('requires the exact existing project rather than creating or choosing another', async () => {
    const { client, project } = fixture();
    project.slug = 'another-app';
    await expect(initializeStagingEnv(client, async () => {})).rejects.toThrow(
      'exactly one existing kitchen-sink',
    );
    expect(client.listSecrets).not.toHaveBeenCalled();
    expect(client.setSecret).not.toHaveBeenCalled();
  });

  it('rejects ambiguous project lookup before reading or writing secrets', async () => {
    const { client, project } = fixture();
    client.listProjects.mockResolvedValue([project, { ...project, id: 'different' }]);
    await expect(initializeStagingEnv(client, async () => {})).rejects.toThrow(
      'exactly one existing kitchen-sink',
    );
    expect(client.listSecrets).not.toHaveBeenCalled();
    expect(client.setSecret).not.toHaveBeenCalled();
  });

  it('does not write when listing secrets fails', async () => {
    const { client } = fixture();
    client.listSecrets.mockRejectedValue(new Error('unavailable'));
    await expect(initializeStagingEnv(client, async () => {})).rejects.toThrow('unavailable');
    expect(client.setSecret).not.toHaveBeenCalled();
  });

  it('does not write any value when schema validation fails', async () => {
    const { client } = fixture();
    await expect(
      initializeStagingEnv(client, async () => {
        throw new Error('invalid schema');
      }),
    ).rejects.toThrow('invalid schema');
    expect(client.setSecret).not.toHaveBeenCalled();
  });

  it('stops immediately without retrying an ambiguous write failure', async () => {
    const { client } = fixture();
    client.setSecret.mockRejectedValue(new Error('connection lost'));
    await expect(initializeStagingEnv(client, async () => {})).rejects.toThrow('connection lost');
    expect(client.setSecret).toHaveBeenCalledTimes(1);
  });

  it('verifies persisted secrets after live propagation fails, without retrying writes', async () => {
    const { client, values } = fixture();
    client.setSecret.mockImplementation(async (_id, name, value) => {
      values.set(name, value);
      throw apiError(502, {
        error: 'secret stored but live propagation failed',
        name,
        liveUpdated: false,
      });
    });
    const steps: Array<string> = [];
    expect(
      await initializeStagingEnv(
        client,
        async () => {},
        (step) => steps.push(step),
      ),
    ).toEqual(['APP_NAME', 'SECRET_KEY', 'API_URL']);
    expect(client.setSecret).toHaveBeenCalledTimes(3);
    expect(client.listSecrets).toHaveBeenCalledTimes(4);
    expect(steps).toContain('verifying stored API_URL');
  });

  it.each([
    {
      status: 500,
      body: {
        error: 'secret stored but live propagation failed',
        name: 'APP_NAME',
        liveUpdated: false,
      },
    },
    { status: 502, body: { error: 'upstream unavailable', name: 'APP_NAME', liveUpdated: false } },
    {
      status: 502,
      body: {
        error: 'secret stored but live propagation failed',
        name: 'OTHER',
        liveUpdated: false,
      },
    },
    {
      status: 502,
      body: {
        error: 'secret stored but live propagation failed',
        name: 'APP_NAME',
        liveUpdated: true,
      },
    },
    {
      status: 502,
      body: {
        error: 'secret stored but live propagation failed',
        name: 'APP_NAME',
        liveUpdated: false,
      },
    },
  ])('rejects unconfirmed or unrelated failures: %j', async ({ status, body }) => {
    const { client } = fixture();
    const error = apiError(status, body);
    client.setSecret.mockRejectedValue(error);
    await expect(initializeStagingEnv(client, async () => {})).rejects.toBe(error);
    expect(client.setSecret).toHaveBeenCalledTimes(1);
  });

  it.each([200, 500, 502])(
    'validates the real schema and keeps API response %i values private',
    (status) => {
      const script = fileURLToPath(
        new URL('../../../scripts/kitchen-sink-staging-env.ts', import.meta.url),
      );
      // Exercise the real entrypoint and API client while preventing all live I/O.
      const preload = `const stored = new Set(); globalThis.fetch = async (url, options) => {
      if (url === 'https://api.staging.void.cloud/projects') {
        return Response.json([{ id: 'fake', slug: 'kitchen-sink' }]);
      }
      if (url === 'https://api.staging.void.cloud/projects/fake/secrets') {
        return Response.json([...stored].map(name => ({name})));
      }
      const name = url.split('/').at(-1);
      if (${status} === 502) {
        stored.add(name);
        return Response.json({ error: 'secret stored but live propagation failed', name, liveUpdated: false, details: 'MUST_NOT_LOG_' + options.body }, {status: 502});
      }
      return Response.json(
        { ok: ${status === 200}, error: 'MUST_NOT_LOG_' + options.body },
        { status: ${status} }
      );
    };`;
      const result = spawnSync(
        process.execPath,
        ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, script],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            VOID_API_URL: 'https://api.staging.void.cloud',
            VOID_TOKEN: 'fake-token',
            CF_ACCESS_CLIENT_ID: 'fake-access-id',
            CF_ACCESS_CLIENT_SECRET: 'fake-access-secret',
          },
        },
      );
      if (status !== 500) {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'Initialized staging kitchen-sink secrets: APP_NAME, SECRET_KEY, API_URL',
        );
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Staging kitchen-sink fixture setup failed.');
        expect(result.stderr).toContain('Failed while setting APP_NAME (HTTP 500).');
      }
      expect(result.stdout + result.stderr).not.toContain('MUST_NOT_LOG_');
      expect(result.stdout + result.stderr).not.toContain('fake-token');
      expect(result.stdout + result.stderr).not.toContain('fake-access-secret');
    },
  );
});
