import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { hasHelpPage } from '../../src/cli/help.ts';
import { operatorCommands, parseOperatorArgs } from '../../src/cli/operator-args.ts';
import {
  OPERATOR_KEYRING_SERVICE,
  readOperatorToken,
  resolveOperatorOrigin,
  saveOperatorToken,
} from '../../src/cli/operator-auth.ts';
import { OperatorClient } from '../../src/cli/operator-client.ts';
import { followOperatorLogs, runOperatorCommand } from '../../src/cli/operator-cmd.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import {
  getActivePlatformConnection,
  savePlatformConnection,
} from '../../src/cli/platform-registry.ts';

const keyring = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/cli/keyring.ts', () => ({
  readKeyringPassword: keyring.read,
  writeKeyringPassword: keyring.write,
  deleteKeyringPassword: keyring.remove,
}));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'void-operator-'));
  vi.stubEnv('VOID_PLATFORM_REGISTRY_DIR', directory);
  vi.stubEnv('VOID_API_URL', '');
  vi.stubEnv('VOID_OPERATOR_TOKEN', '');
  vi.stubEnv('VOID_TOKEN', 'deployment-only');
  keyring.read.mockReturnValue(null);
  keyring.write.mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function connect(apiUrl: string) {
  return savePlatformConnection({
    accountId: null,
    apiUrl,
    applicationDomain: null,
    displayName: apiUrl,
    installationId: null,
    kind: 'connected',
    proxyUrl: null,
  });
}

describe('operator argument and help coverage', () => {
  it('has nested help and routable arguments for every operation', () => {
    for (const command of operatorCommands) {
      expect(hasHelpPage(['platform', command.group, command.action])).toBe(true);
      const parameters = (command.positional ?? []).map((name) =>
        name === 'type' ? 'email' : `${name}-value`,
      );
      const result = parsePlatformArgs([command.group, command.action, ...parameters]);
      expect(result).toMatchObject({
        subcommand: 'operator',
        group: command.group,
        action: command.action,
      });
    }
  });
  it('accepts explicit flags before the operator group and encodes IDs', () => {
    expect(
      parsePlatformArgs(['--connection', 'chosen', '--json', 'user', 'show', 'user /?x']),
    ).toMatchObject({ connection: 'chosen', json: true, path: '/users/user%20%2F%3Fx' });
    expect(
      parseOperatorArgs([
        'signup',
        'allow',
        'email',
        '*@example.com',
        '--note',
        'Operators only',
        '--plan',
      ]),
    ).toMatchObject({
      method: 'POST',
      body: { type: 'email', pattern: '*@example.com', note: 'Operators only' },
      plan: true,
    });
    expect(
      parseOperatorArgs([
        'signup',
        'allow',
        'identity',
        'company-sso',
        'Employee-42',
        '--note',
        'No email',
      ]),
    ).toMatchObject({
      path: '/signup/allow',
      method: 'POST',
      body: {
        type: 'identity',
        connectionId: 'company-sso',
        subject: 'Employee-42',
        note: 'No email',
      },
    });
    expect(
      parseOperatorArgs(['signup', 'disallow', 'identity', 'company-sso', 'Employee-42']),
    ).toMatchObject({
      path: '/signup/disallow',
      body: { type: 'identity', connectionId: 'company-sso', subject: 'Employee-42' },
    });
    expect(parsePlatformArgs(['--timeout', '600', 'user', 'delete', 'id'])).toMatchObject({
      timeoutMs: 600_000,
    });
    expect(
      parsePlatformArgs(['system', 'sandbox-drain', '--plan', '--cursor', '{"phase":"resources"}']),
    ).toMatchObject({
      method: 'POST',
      plan: true,
      body: { cursor: '{"phase":"resources"}' },
    });
  });
  it('routes the email group to the operator email endpoints', () => {
    expect(parseOperatorArgs(['email', 'policy'])).toMatchObject({
      method: 'GET',
      path: '/email/policy',
    });
    expect(
      parseOperatorArgs(['email', 'policy-set', 'domains', '--domains', 'a.example,b.example']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/policy',
      body: { mode: 'domains', domains: 'a.example,b.example' },
    });
    expect(parseOperatorArgs(['email', 'settings-set', '--domains', 'admin'])).toMatchObject({
      method: 'POST',
      path: '/email/settings',
      body: { domains: 'admin' },
    });
    expect(
      parseOperatorArgs(['email', 'limit', 'my/slug', '--monthly', '500', '--burst', '20']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/projects/my%2Fslug/limit',
      body: { monthly: '500', burst: '20' },
    });
    expect(() => parseOperatorArgs(['email', 'policy', '--domains', 'x'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'limit'])).toThrow();
    expect(
      parseOperatorArgs(['email', 'logs', 'project/id', '--page', '2', '--limit', '100']),
    ).toMatchObject({
      method: 'GET',
      path: '/email/projects/project%2Fid/logs',
      query: { page: '2', limit: '100' },
    });
    expect(() => parseOperatorArgs(['email', 'logs', 'project', '--limit', '101'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'logs', 'project', '--follow'])).toThrow();
  });
  it('routes attempt inspection and attested resolution with a bounded audit reason', () => {
    expect(
      parseOperatorArgs(['email', 'attempts', '--project', 'my-project', '--page', '2']),
    ).toMatchObject({
      method: 'GET',
      path: '/email/attempts',
      query: { project: 'my-project', page: '2' },
    });
    expect(
      parseOperatorArgs([
        'email',
        'attempt-resolve',
        'attempt/id',
        '--ended',
        '--reason',
        'Worker execution ended',
        '--yes',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/attempts/attempt%2Fid/resolve',
      body: { ended: true, reason: 'Worker execution ended' },
      yes: true,
    });
    expect(() => parseOperatorArgs(['email', 'attempts', '--ended'])).toThrow();
    expect(
      parseOperatorArgs([
        'email',
        'operation-resolve',
        'operation/id',
        '--ended',
        '--outcome',
        'not-applied',
        '--reason',
        'Provider audit completed',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/operations/operation%2Fid/resolve',
      body: {
        ended: true,
        outcome: 'not-applied',
        reason: 'Provider audit completed',
      },
    });
  });
  it('routes the email domain verbs', () => {
    expect(parseOperatorArgs(['email', 'domains', '--project', 'hr-portal'])).toMatchObject({
      method: 'GET',
      path: '/email/domains',
      query: { project: 'hr-portal' },
    });
    expect(
      parseOperatorArgs([
        'email',
        'domain-add',
        'mail.example.com',
        '--project',
        'hr-portal',
        '--token-stdin',
        '--yes',
      ]),
    ).toMatchObject({
      method: 'POST',
      path: '/email/domains',
      body: { domain: 'mail.example.com', project: 'hr-portal' },
      tokenStdin: true,
      yes: true,
    });
    expect(parseOperatorArgs(['email', 'domain-status', 'mail.example.com'])).toMatchObject({
      method: 'GET',
      path: '/email/domains/mail.example.com',
    });
    expect(parseOperatorArgs(['email', 'domain-sync', 'mail.example.com'])).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/sync',
      body: {},
    });
    expect(parseOperatorArgs(['email', 'domain-rotate-secret', 'mail.example.com'])).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/rotate-secret',
      body: {},
    });
    expect(parseOperatorArgs(['email', 'domain-remove', 'mail.example.com']).body).toEqual({});
    expect(
      parseOperatorArgs(['email', 'domain-remove', 'mail.example.com', '--token-stdin', '--yes']),
    ).toMatchObject({
      method: 'POST',
      path: '/email/domains/mail.example.com/remove',
      body: {},
      tokenStdin: true,
      yes: true,
    });
    expect(() => parseOperatorArgs(['email', 'domain-remove', 'x', '--force'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'domain-sync', 'x', '--force'])).toThrow();
    expect(() => parseOperatorArgs(['email', 'domain-add', 'x', '--force'])).toThrow();
  });
  it.each([
    ['user', 'list', '--limit', '101'],
    ['user', 'list', '--page', '1e3'],
    ['user', 'list', '--yes'],
    ['user', 'delete', 'id', '--yes', '--plan'],
    ['user', 'show', '..'],
    ['user', 'list', '--json', '--json'],
    ['user', 'list', '--search'],
    ['user', 'list', '--wat', 'value'],
    ['build', 'logs', 'id', '--since', '-1'],
    ['build', 'logs', 'id', '--since', '9007199254740992'],
    ['worker', 'rollback', 'api', 'version', '--environment', 'preview'],
    ['signup', 'allow', 'typo', '*'],
    ['signup', 'allow', 'identity', 'company-sso'],
    ['signup', 'allow', 'identity', 'Company', 'employee'],
    ['signup', 'disallow', 'identity', 'company', 'employee', 'extra'],
    ['signup', 'remove', 'identity', 'company'],
    ['auth', 'login', '--yes'],
    ['user', 'delete', 'id', '--timeout', '0'],
    ['user', 'delete', 'id', '--timeout', '3601'],
    ['user', 'delete', 'id', '--timeout', '1.5'],
    ['user', 'show', 'id', '--timeout', '60'],
  ])('rejects malformed command %j', (...args) => {
    expect(() => parseOperatorArgs(args)).toThrow();
  });
});

describe('operator credential isolation', () => {
  it('uses only registered explicit connections, without changing the active connection', () => {
    const first = connect('https://one.example');
    const second = connect('https://two.example');
    vi.stubEnv('VOID_API_URL', 'https://override.example');
    expect(resolveOperatorOrigin(first.id)).toBe(first.apiUrl);
    expect(getActivePlatformConnection()?.id).toBe(second.id);
    expect(resolveOperatorOrigin()).toBe('https://override.example');
    expect(() => resolveOperatorOrigin('https://unregistered.example')).toThrow('registered');
  });
  it('rejects headless credentials with an implicit origin', () => {
    const connection = connect('https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    expect(() => resolveOperatorOrigin()).toThrow('explicit');
    expect(resolveOperatorOrigin(connection.id)).toBe(connection.apiUrl);
  });
  it('never falls back to a deploy token and keeps operator credentials in a separate service', () => {
    expect(() => readOperatorToken('https://one.example')).toThrow('No operator session');
    saveOperatorToken('https://one.example', 'operator');
    expect(keyring.write).toHaveBeenCalledWith(
      OPERATOR_KEYRING_SERVICE,
      expect.stringMatching(/^platform:/),
      'operator',
    );
    keyring.write.mockReturnValue(false);
    expect(() => saveOperatorToken('https://one.example', 'operator')).toThrow('keychain');
  });
});

describe('operator transport and execution', () => {
  it('encodes queries and refuses credential-bearing redirects without retrying', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }),
      );
    const client = new OperatorClient('https://one.example', 'operator', fetcher);
    await expect(
      client.request('/users', { query: { search: 'x&admin=1' } }),
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/users?search=x%26admin%3D1',
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      redirect: 'manual',
      headers: { Authorization: 'Bearer operator' },
      signal: expect.any(AbortSignal),
    });
  });
  it('preserves structured partial errors and never retries mutations', async () => {
    const details = { completed: ['one'], failed: ['two'] };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: 'partial_failure', message: 'Some resources remain.', details },
          { status: 502 },
        ),
      );
    await expect(
      new OperatorClient('https://one.example', 'token', fetcher).request('/users/id/delete', {
        method: 'POST',
        body: {},
      }),
    ).rejects.toMatchObject({ code: 'partial_failure', details });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses short read deadlines, longer mutation deadlines, and bounded overrides', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const client = new OperatorClient('https://one.example', 'operator', fetcher);

    await expect(
      client.request('/users/id/delete', { method: 'POST', body: {}, timeoutMs: 3_600_001 }),
    ).rejects.toMatchObject({ code: 'invalid_timeout' });
    expect(fetcher).not.toHaveBeenCalled();

    const read = client.request('/users');
    const readFailure = expect(read).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('Check connectivity'),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await readFailure;

    const mutation = client.request('/users/id/delete', { method: 'POST', body: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((fetcher.mock.calls[1]![1]!.signal as AbortSignal).aborted).toBe(false);
    const mutationFailure = expect(mutation).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('outcome may be unknown'),
    });
    await vi.advanceTimersByTimeAsync(270_000);
    await mutationFailure;

    const overridden = client.request('/users/id/delete', {
      method: 'POST',
      body: {},
      timeoutMs: 2_000,
    });
    const overrideFailure = expect(overridden).rejects.toMatchObject({
      code: 'request_timeout',
      message: expect.stringContaining('2-second timeout'),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await overrideFailure;
    vi.useRealTimers();
  });
  it('requires authorization before preview and validates preview before executing', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    await expect(runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id']))).rejects.toThrow(
      '--yes',
    );
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      runOperatorCommand(parseOperatorArgs(['user', 'delete', 'id', '--yes'])),
    ).rejects.toThrow('valid mutation preview');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('performs plan only and pins rollback-all execution to previewed versions', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const preview = {
      dryRun: true,
      action: 'workers.rollback-all',
      target: 'production',
      versions: { api: 'version-a' },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(preview));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--plan', '--json']));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    await runOperatorCommand(parseOperatorArgs(['worker', 'rollback-all', '--yes']));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      versions: { api: 'version-a' },
    });
  });
  it.each(['--plan', '--yes'])(
    'reads a cleanup token once for %s without printing it',
    async (mode) => {
      vi.stubEnv('VOID_API_URL', 'https://one.example');
      vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdin = vi
        .spyOn(process.stdin, Symbol.asyncIterator)
        .mockImplementation(async function* () {
          yield 'replacement-cloudflare-token\n';
          return undefined;
        });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            dryRun: true,
            action: 'email.domain.remove',
            target: { domain: 'mail.example.com', credentialReplacement: true },
          }),
        )
        .mockResolvedValueOnce(Response.json({ operationStatus: 'completed' }));
      vi.stubGlobal('fetch', fetcher);
      await runOperatorCommand(
        parseOperatorArgs(['email', 'domain-remove', 'mail.example.com', '--token-stdin', mode]),
      );
      expect(stdin).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(mode === '--plan' ? 1 : 2);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
        apiToken: 'replacement-cloudflare-token',
        dryRun: true,
      });
      if (mode === '--yes') {
        expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
          apiToken: 'replacement-cloudflare-token',
        });
      }
      expect(JSON.stringify([output.mock.calls, stderr.mock.calls])).not.toContain(
        'replacement-cloudflare-token',
      );
    },
  );
  it('prints email recipient outcomes through the operator logs command', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          projectId: 'project-1',
          page: 1,
          limit: 20,
          logs: [
            {
              operationId: 'action-1',
              recipient: 'one@example.com',
              status: 'provider_accepted',
              transport: 'binding',
            },
          ],
        }),
      ),
    );
    await runOperatorCommand(parseOperatorArgs(['email', 'logs', 'project-1']));
    const printed = output.mock.calls.flat().join('\n');
    expect(printed).toContain('one@example.com');
    expect(printed).toContain('provider_accepted');
  });
  it('previews then submits an attested email attempt resolution', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'email.attempt.resolve',
          target: { attemptId: 'er_1' },
        }),
      )
      .mockResolvedValueOnce(Response.json({ state: 'outcome_unknown', charged: true }));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'email',
        'attempt-resolve',
        'er_1',
        '--ended',
        '--reason',
        'Worker execution ended',
        '--yes',
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://one.example/operator/v1/email/attempts/er_1/resolve',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      ended: true,
      reason: 'Worker execution ended',
      dryRun: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      ended: true,
      reason: 'Worker execution ended',
    });
  });
  it('pins email operation recovery execution to the previewed step fence', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          dryRun: true,
          action: 'email.operation.resolve',
          target: {
            operationId: 'eop_1',
            stepId: 'estep_1',
            attempt: 2,
            requestDigest: 'digest-1',
            resourceIdentity: 'account/zone/worker/relay/7',
            connectionId: 'ezc_1',
            desiredGeneration: 4,
            routeId: 'edr_1',
            routeDesiredGeneration: 3,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ status: 'pending' }));
    vi.stubGlobal('fetch', fetcher);
    await runOperatorCommand(
      parseOperatorArgs([
        'email',
        'operation-resolve',
        'eop_1',
        '--ended',
        '--outcome',
        'applied',
        '--reason',
        'Exact provider resource verified',
        '--yes',
      ]),
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      ended: true,
      outcome: 'applied',
      reason: 'Exact provider resource verified',
      stepId: 'estep_1',
      attempt: 2,
      requestDigest: 'digest-1',
      resourceIdentity: 'account/zone/worker/relay/7',
      connectionId: 'ezc_1',
      desiredGeneration: 4,
      routeId: 'edr_1',
      routeDesiredGeneration: 3,
    });
  });
  it('drains runtime cursors and rejects repeated cursors instead of spinning', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [], nextCursor: 'page-2', watermark: '2030-01-01T00:00:00Z' }),
      );
    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['deployment', 'logs', 'id', '--follow', '--since', '1h']),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain('cursor=page-2');
    expect(String(fetcher.mock.calls[1]![0])).toContain('since=1h');
  });
  it('follows ingestion cursors with overlap dedupe and preserves identical row counts', async () => {
    const controller = new AbortController();
    const repeated = {
      timestamp: 1000,
      ingestedAt: 1900,
      method: 'GET',
      url: '/same',
      status: '200',
      logs: [],
      exceptions: [],
    };
    const completedLate = {
      timestamp: 1500,
      ingestedAt: 2500,
      method: 'POST',
      url: '/completed-late',
      status: '201',
      logs: [],
      exceptions: [],
    };
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [repeated], nextCursor: null, watermark: '2000' }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        return Response.json({
          data: [repeated, repeated, completedLate],
          nextCursor: null,
          watermark: '3000',
        });
      });

    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['deployment', 'logs', 'id', '--follow', '--since', '1h']),
      controller.signal,
      0,
    );

    const lines = write.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('/same'))).toHaveLength(2);
    expect(lines.filter((line) => line.includes('/completed-late'))).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('since=1h');
    expect(String(fetcher.mock.calls[1]![0])).toContain('after=2000');
    expect(String(fetcher.mock.calls[1]![0])).not.toContain('since=');
  });
  it('fails explicitly when a runtime follow window exceeds its dedupe bound', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const row = {
      timestamp: 1000,
      ingestedAt: 1900,
      method: 'GET',
      url: '/same',
      status: '200',
      logs: [],
      exceptions: [],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: Array.from({ length: 10_001 }, () => row),
        nextCursor: null,
        watermark: '2000',
      }),
    );

    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['deployment', 'logs', 'id', '--follow']),
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('renders deployment status, log messages, and exceptions in human output', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              timestamp: 1234,
              method: 'GET',
              url: '/broken',
              status: '503',
              outcome: 'exception',
              logs: [{ level: 'error', message: 'request failed' }],
              exceptions: [{ name: 'TypeError', message: 'missing value' }],
            },
          ],
          nextCursor: null,
          watermark: '1235',
        }),
      ),
    );

    await runOperatorCommand(parseOperatorArgs(['deployment', 'logs', 'deployment-1']));

    expect(write.mock.calls.map(([line]) => String(line))).toEqual([
      '1234 GET /broken 503',
      '  [error] request failed',
      '  TypeError: missing value',
    ]);
  });

  it('renders every worker and audit event field without table-column truncation', async () => {
    vi.stubEnv('VOID_API_URL', 'https://one.example');
    vi.stubEnv('VOID_OPERATOR_TOKEN', 'operator');
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          batchId: 'batch-1',
          environment: 'production',
          events: [
            {
              id: 'event-1',
              batch_id: 'batch-1',
              action: 'rollback_all',
              worker_name: 'api',
              environment: 'production',
              version_id: 'version-failed',
              script_name: 'void-api',
              status: 'failed',
              error_message: 'Version no longer exists.',
              auditError: 'Could not persist the outcome.',
              admin_login: 'operator',
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          events: [
            {
              id: 'audit-1',
              login: 'operator',
              action: 'workers/api/rollback',
              target: '{"worker":"api","versionId":"version-failed"}',
              status: 'failed',
              http_status: 207,
              created_at: '2030-01-01T00:00:00Z',
            },
          ],
          page: 1,
          limit: 25,
          total: 1,
        }),
      );
    vi.stubGlobal('fetch', fetcher);

    await runOperatorCommand(parseOperatorArgs(['worker', 'events', 'batch-1']));
    await runOperatorCommand(parseOperatorArgs(['system', 'events']));

    const rendered = write.mock.calls.map(([line]) => String(line)).join('\n');
    expect(rendered).toContain('version id: version-failed');
    expect(rendered).toContain('error message: Version no longer exists.');
    expect(rendered).toContain('audit Error: Could not persist the outcome.');
    expect(rendered).toContain('action: workers/api/rollback');
    expect(rendered).toContain('target: {"worker":"api","versionId":"version-failed"}');
  });

  it('follows build log sequence and stops when terminal', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        lines: [{ seq: 3, text: 'done' }],
        lastSeq: 3,
        terminal: true,
        logsComplete: true,
      }),
    );
    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '2', '--json']),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('since=2');
  });

  it('waits for drain completion across stable terminal pages and prints a delayed marker', async () => {
    const write = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false }),
      )
      .mockResolvedValueOnce(
        Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false }),
      )
      .mockResolvedValueOnce(
        Response.json({
          lines: [{ seq: 4, line: '[build-manager] container terminated: timed out' }],
          lastSeq: 4,
          terminal: true,
          logsComplete: true,
        }),
      );

    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '3', '--json']),
      undefined,
      0,
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('since')),
    ).toEqual(['3', '3', '3']);
    expect(write.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
      'container terminated: timed out',
    );
  });

  it('fails within a bound when a terminal producer never confirms completion', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now += 60_000;
      return Response.json({ lines: [], lastSeq: 3, terminal: true, logsComplete: false });
    });

    await expect(
      followOperatorLogs(
        new OperatorClient('https://one.example', 'token', fetcher),
        parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '3', '--json']),
        undefined,
        0,
      ),
    ).rejects.toThrow('did not confirm completion');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('uses a bounded quiet window for legacy terminal responses without completion state', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      now += 10_000;
      return Response.json({ lines: [], lastSeq: 3, terminal: true });
    });

    await followOperatorLogs(
      new OperatorClient('https://one.example', 'token', fetcher),
      parseOperatorArgs(['build', 'logs', 'id', '--follow', '--since', '3', '--json']),
      undefined,
      0,
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
