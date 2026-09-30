import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { PlatformApiError, PlatformClient, parsePlatformErrorBody } from '../../src/cli/client.ts';
import { formatStreamDeployError } from '../../src/cli/deploy-errors.ts';

vi.mock('../../src/cli/cf-access.ts', () => ({
  ensureCloudflaredToken: vi.fn(),
  ensurePlatformAccessToken: vi.fn(),
  isCloudflareAccessChallenge: () => false,
}));
afterEach(() => vi.unstubAllGlobals());
const client = () => new PlatformClient('test-token', 'https://api.example.test');
const project = 'project_1';
const collaborator = 'collaborator, admin, or owner';
const admin = 'admin or owner';
const owner = 'Only the project owner';
const reader = 'project membership (reader or higher)';

describe('PlatformClient permission errors', () => {
  const cases: Array<[string, (client: PlatformClient) => Promise<unknown>, string]> = [
    ['list secrets', (c) => c.listSecrets(project), collaborator],
    ['set secret', (c) => c.setSecret(project, 'NAME', 'private-value'), collaborator],
    ['delete secret', (c) => c.deleteSecret(project, 'NAME'), collaborator],
    ['add domain', (c) => c.addDomain(project, 'example.test'), admin],
    ['remove domain', (c) => c.removeDomain(project, 'domain_1'), admin],
    ['list domains', (c) => c.listDomains(project), reader],
    ['domain status', (c) => c.getDomainStatus(project, 'domain_1'), reader],
    ['provision database', (c) => c.provisionDatabase(project, 'postgres://private'), collaborator],
    ['database URL write', (c) => c.setDatabaseUrl(project, 'postgres://private'), collaborator],
    ['database URL read', (c) => c.getDatabaseUrl(project), owner],
    ['migration status', (c) => c.getMigrationStatus(project), reader],
    ['migrate', (c) => c.applyRemoteMigrations(project, []), collaborator],
    ['rename migrations', (c) => c.renameMigrations(project, []), collaborator],
    ['rollback', (c) => c.rollback(project, 'deploy_1'), collaborator],
    ['cancel', (c) => c.cancelDeployment(project, 'deploy_1'), collaborator],
    ['purge', (c) => c.purgeCache(project), collaborator],
    ['upload URLs', (c) => c.requestUploadUrls(project, []), collaborator],
    ['prerender credential', (c) => c.createPrerenderToken(project), collaborator],
    ['team roster', (c) => c.listProjectMembers(project), reader],
    ['team invitation list', (c) => c.listProjectInvitations(project), admin],
    ['team invite', (c) => c.inviteProjectMember(project, 'target@example.test', 'reader'), admin],
    ['team role', (c) => c.updateProjectMemberRole(project, 'user_1', 'reader'), admin],
    ['team remove', (c) => c.removeProjectMember(project, 'user_1'), admin],
    ['team revoke', (c) => c.revokeProjectInvitation(project, 'invitation_1'), admin],
    ['token list', (c) => c.listProjectTokens(project), owner],
    ['token create', (c) => c.createProjectToken(project, {}), owner],
    ['token renew', (c) => c.renewProjectToken(project, 'token_1'), owner],
    ['token revoke', (c) => c.revokeProjectToken(project, 'token_1'), owner],
    ['project delete', (c) => c.deleteProject(project), owner],
    ['deployments', (c) => c.listDeployments(project), reader],
    ['resources', (c) => c.getResources(project), reader],
    ['builds', (c) => c.listBuilds(project), reader],
    ['build logs', (c) => c.getBuildLogs(project, 'build_1'), reader],
    ['GitHub status', (c) => c.getGithubConnection(project), reader],
    [
      'GitHub connect',
      (c) =>
        c.connectGithub(project, {
          installationId: '1',
          repoFullName: 'owner/repo',
          branch: 'main',
        }),
      admin,
    ],
    ['GitHub update', (c) => c.updateGithubConnection(project, { branch: 'main' }), admin],
    ['GitHub disconnect', (c) => c.deleteGithubConnection(project), admin],
    ['email usage', (c) => c.getEmailUsage(project), reader],
    ['email destination add', (c) => c.addEmailDestination(project, 'target@example.test'), admin],
    ['email domain removal', (c) => c.removeEmailDomain(project, 'example.test'), admin],
    ['Zero Trust status', (c) => c.getProjectZeroTrust(project), reader],
    ['Zero Trust update', (c) => c.setProjectZeroTrust(project, true), admin],
    ['Zero Trust reconcile', (c) => c.reconcileProjectZeroTrust(project), admin],
  ];
  it.each(cases)(
    'explains required access for %s on older APIs',
    async (_name, operation, requirement) => {
      const body = JSON.stringify({ error: 'forbidden' });
      const fetch = vi.fn(async () => new Response(body, { status: 403 }));
      vi.stubGlobal('fetch', fetch);
      const error = await operation(client()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PlatformApiError);
      expect(error).toMatchObject({ status: 403, code: 'forbidden', body });
      expect((error as Error).message).toContain(requirement);
      expect((error as Error).message).toMatch(/Failed|failed/);
      expect((error as Error).message).not.toMatch(/\{"|auth logout|private-value|postgres:\/\//);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('prefers the server explanation without claiming the current role', async () => {
    const body = JSON.stringify({
      error: 'forbidden',
      message: 'This deployment token cannot read secrets. Use your platform login.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 403 })),
    );
    const error = await client()
      .listSecrets(project)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 403, code: 'forbidden', body });
    expect((error as Error).message).toContain('Failed to list secrets');
    expect((error as Error).message).toContain('Use your platform login.');
    expect((error as Error).message).not.toContain('collaborator');
  });

  it('keeps account and repository denials distinct from project role requirements', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'repository access revoked' }, { status: 403 })),
    );
    await expect(
      client().connectGithub(project, {
        installationId: '1',
        repoFullName: 'owner/repo',
        branch: 'main',
      }),
    ).rejects.toThrow('repository access revoked');
    await expect(client().listGithubInstallations()).rejects.not.toThrow('admin or owner');
  });

  it.each(['account suspended', 'project owner suspended'])(
    'explains %s without changing accounts',
    (code) => {
      const error = new PlatformApiError(
        'Failed to list secrets',
        403,
        JSON.stringify({ error: code }),
        'configure',
      );
      expect(error.message).toContain('platform administrator');
      expect(error.message).not.toMatch(/collaborator|auth logout/);
      expect(error.code).toBe(code);
    },
  );

  it('retains opaque denial bodies for diagnostics without dumping HTML', () => {
    const body = '<html>Cloudflare Access denied</html>';
    const error = new PlatformApiError('Read failed', 403, body, 'read');
    expect(error.body).toBe(body);
    expect(error.message).toContain('access gateway');
    expect(error.message).not.toMatch(/<html>|reader|collaborator/);
    expect(formatStreamDeployError(error, null).message).not.toContain('<html>');
  });

  it.each(['', '{}', '[]', '{"message":{}}', '{"message":"","error":42}', '{malformed'])(
    'explains an empty/malformed denial without raw JSON: %s',
    (body) => {
      const error = new PlatformApiError('Read failed', 403, body, 'read');
      expect(error.body).toBe(body);
      expect(error.message).toContain('confirm your access');
      expect(error.message).not.toMatch(/[{}]|\[\]|undefined|\[object Object\]/);
    },
  );

  it('keeps useful provider text and rejects invalid error field types', () => {
    const provider = 'Access policy requires a service token.';
    expect(new PlatformApiError('Read failed', 403, provider, 'read').message).toContain(provider);
    expect(parsePlatformErrorBody('[]')).toBeNull();
    const malformed = new PlatformApiError(
      'Read failed',
      403,
      '{"message":{"private":"value"},"error":42}',
    );
    expect(malformed.code).toBeUndefined();
    expect(malformed.message).not.toContain('[object Object]');
  });

  it.each([
    { error: 'forbidden', message: '<html>upstream login</html>' },
    { error: 'forbidden', message: '{"error":"upstream"}' },
    { error: '<h1>Denied</h1>', message: [] },
    { error: '{"error":"upstream"}', message: '["denied"]' },
  ])('never renders nested markup or JSON error fields: %j', (payload) => {
    const body = JSON.stringify(payload);
    const error = new PlatformApiError('Read failed', 403, body);
    expect(error.body).toBe(body);
    expect(error.code).toBe(payload.error);
    expect(error.message).not.toMatch(/[<>[\]{}]/);
  });

  it('removes terminal escape sequences from server and provider explanations', () => {
    const server = new PlatformApiError(
      'Read failed',
      403,
      JSON.stringify({
        error: 'forbidden',
        message: '\u001b[31mAsk the owner for access.\u001b[0m',
      }),
    );
    const provider = new PlatformApiError(
      'Read failed',
      403,
      '\u001b[31mA gateway service token is required.\u001b[0m',
    );
    expect(server.message).toContain('Ask the owner for access.');
    expect(provider.message).toContain('gateway service token');
    expect(server.message + provider.message).not.toContain('\u001b');
  });

  it.each([
    [401, 'session revoked; sign in again', 'void connect'],
    [401, 'user not found', 'active account'],
    [401, 'deploy credential revoked or expired', 'project owner'],
    [403, 'deploy token build is no longer active', 'Start a new build'],
    [403, 'github_identity_required', 'void github link'],
    [403, 'connect_authorization_required', 'interactive terminal'],
    [403, 'invalid connect grant', 'void github connect'],
  ])('gives recovery for legacy %s %s', (status, code, recovery) => {
    const error = new PlatformApiError('Request failed', status, JSON.stringify({ error: code }));
    expect(error.code).toBe(code);
    expect(error.message).toContain(recovery);
    expect(error.message).not.toContain('auth logout');
  });

  it.each(['invalid or expired token', 'unauthorized', 'missing token'])(
    'explains recovery for legacy 401 %s',
    (code) => {
      const error = new PlatformApiError('Read failed', 401, JSON.stringify({ error: code }));
      expect(error.code).toBe(code);
      expect(error.message).toContain('void connect <platform-url>');
      expect(error.message).toContain('VOID_TOKEN');
      expect(error.message).not.toContain('auth logout');
    },
  );

  it.each(['', '<html>Login required</html>', '{"message":{}}'])(
    'explains opaque 401 without misdiagnosing a role: %s',
    (body) => {
      const error = new PlatformApiError('Read failed', 401, body, 'read');
      expect(error.message).toContain('credentials');
      expect(error.message).not.toMatch(/<html>|reader|admin|\{"/);
      expect(error.status).toBe(401);
    },
  );

  it('preserves useful server messages and metadata through deploy formatting', () => {
    const body = JSON.stringify({
      error: 'forbidden',
      message: 'Deploying requires collaborator access. Ask a project admin to update your access.',
    });
    const original = new PlatformApiError('Deploy failed', 403, body, 'deploy');
    const formatted = formatStreamDeployError(original, 'deploy_1', '/tmp/void.log');
    expect(formatted).toBe(original);
    expect(formatted).toMatchObject({ code: 'forbidden', status: 403, body });
    expect(formatted.message).toContain('Ask a project admin');
    expect(formatted.message).toContain('Deployment: deploy_1');
    expect(formatted.message).toContain('Detailed log: /tmp/void.log');
  });
});

describe('deploy preflight rejections', () => {
  const assets = { '/index.html': { hash: 'hash', size: 1 } };
  it.each([
    [403, { error: 'forbidden' }],
    [403, { error: 'project owner suspended' }],
    [401, { error: 'invalid or expired token' }],
    [426, { error: 'cli_outdated', message: 'Upgrade the CLI.' }],
  ])('stops after an explicit HTTP %s rejection', async (status, body) => {
    const fetch = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().preflight(project, assets)).rejects.toMatchObject({
      status,
      code: body.error,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500])('retains the optional optimization fallback for HTTP %s', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unsupported or unavailable', { status })),
    );
    await expect(client().preflight(project, assets)).resolves.toEqual({
      needed: ['/index.html'],
      total: 1,
      skipped: 0,
    });
  });
  it('retains the fallback for opaque provider responses and network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('<html>provider response</html>', { status: 403 }))
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    );
    await expect(client().preflight(project, assets)).resolves.toMatchObject({ skipped: 0 });
    await expect(client().preflight(project, assets)).resolves.toMatchObject({ skipped: 0 });
  });
});
