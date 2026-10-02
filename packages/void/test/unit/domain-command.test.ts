import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DomainStatusResponse } from '../../src/cli/client.ts';
import type { DomainArgs } from '../../src/cli/domain-args.ts';
import { computeRollup, runDomainCommand } from '../../src/cli/domain.ts';

const mockLogError = vi.fn();
const mockLogSuccess = vi.fn();
const mockLogInfo = vi.fn();
const mockNote = vi.fn();
class ProcessExitError extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}
const mockExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new ProcessExitError(code);
}) as never);

async function runExpectingExit(rt: string, a: DomainArgs): Promise<void> {
  await expect(runDomainCommand(rt, a)).rejects.toBeInstanceOf(ProcessExitError);
}

const mockGetToken = vi.fn();
const mockReadProjectConfig = vi.fn();
const mockReadDeploymentPlatform = vi.fn();
const mockListProjects = vi.fn();
const mockAddDomain = vi.fn();
const mockListDomains = vi.fn();
const mockGetDomainStatus = vi.fn();
const mockRemoveDomain = vi.fn();

vi.mock('@voidzero-dev/vite-plus-prompts', () => ({
  log: {
    error: (...args: Array<unknown>) => mockLogError(...args),
    success: (...args: Array<unknown>) => mockLogSuccess(...args),
    info: (...args: Array<unknown>) => mockLogInfo(...args),
  },
  note: (...args: Array<unknown>) => mockNote(...args),
}));

vi.mock('../../src/cli/auth', () => ({
  getToken: (...args: Array<unknown>) => mockGetToken(...args),
}));

vi.mock('../../src/cli/project', () => ({
  readProjectConfig: (...args: Array<unknown>) => mockReadProjectConfig(...args),
  readDeploymentPlatform: (...args: Array<unknown>) => mockReadDeploymentPlatform(...args),
}));

vi.mock('../../src/cli/client', () => ({
  PlatformClient: class {
    listProjects(...args: Array<unknown>) {
      return mockListProjects(...args);
    }
    addDomain(...args: Array<unknown>) {
      return mockAddDomain(...args);
    }
    listDomains(...args: Array<unknown>) {
      return mockListDomains(...args);
    }
    getDomainStatus(...args: Array<unknown>) {
      return mockGetDomainStatus(...args);
    }
    removeDomain(...args: Array<unknown>) {
      return mockRemoveDomain(...args);
    }
  },
}));

const root = '/project';

function args(overrides: Partial<DomainArgs> & Pick<DomainArgs, 'subcommand'>): DomainArgs {
  return { ...overrides };
}

beforeEach(() => {
  mockLogError.mockReset();
  mockLogSuccess.mockReset();
  mockLogInfo.mockReset();
  mockNote.mockReset();
  mockExit.mockClear();

  mockGetToken.mockReset();
  mockReadProjectConfig.mockReset();
  mockReadDeploymentPlatform.mockReset();
  mockListProjects.mockReset();
  mockAddDomain.mockReset();
  mockListDomains.mockReset();
  mockGetDomainStatus.mockReset();
  mockRemoveDomain.mockReset();

  mockGetToken.mockReturnValue('test-token');
  mockReadProjectConfig.mockReturnValue({ projectId: 'proj_default', slug: 'default' });
  mockReadDeploymentPlatform.mockReturnValue('void');
  mockListProjects.mockResolvedValue([]);
  mockListDomains.mockResolvedValue([]);
  delete process.env.VOID_PROJECT;
});

describe('runDomainCommand top-level guards', () => {
  it('fails when no token is found', async () => {
    mockGetToken.mockReturnValue(null);

    await runExpectingExit(root, args({ subcommand: 'list' }));

    expect(mockLogError).toHaveBeenCalledWith('Not logged in. Run `void account login` first.');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('resolves project from --project <slug> flag', async () => {
    mockListProjects.mockResolvedValue([{ slug: 'foo', id: 'proj_foo' }]);
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, args({ subcommand: 'list', projectSlug: 'foo' }));

    expect(mockListDomains).toHaveBeenCalledWith('proj_foo');
  });

  it('resolves project from readProjectConfig when no slug', async () => {
    mockReadProjectConfig.mockReturnValue({ projectId: 'proj_linked', slug: 'linked' });
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, args({ subcommand: 'list' }));

    expect(mockListDomains).toHaveBeenCalledWith('proj_linked');
  });

  it('errors when no project resolvable', async () => {
    mockReadProjectConfig.mockReturnValue(null);

    await runExpectingExit(root, args({ subcommand: 'list' }));

    expect(mockLogError).toHaveBeenCalledWith(
      'No linked project. Run `void project link` or pass --project <name>.',
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('domainAdd', () => {
  it('prints CNAME + ownership TXT when both records returned', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'foo.example.com.cdn.cloudflare.net',
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.foo', value: 'own-token' },
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(1);
    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).toContain('foo.example.com → foo.example.com.cdn.cloudflare.net');
    expect(content).toContain('TXT (ownership verification)');
    expect(content).toContain('_cf-custom-hostname.foo → own-token');
    // HTTP-DCV: no user-facing SSL-validation records.
    expect(content).not.toContain('TXT (SSL validation)');
  });

  it('skips ownership section when ownership_verification is missing', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).not.toContain('TXT (ownership verification)');
    expect(content).not.toContain('TXT (SSL validation)');
    // Only one record rendered: summary is singular and must not claim "both".
    expect(content).toContain(
      'Add the record above to your DNS, then run `void domain status foo.example.com` to check progress.',
    );
    expect(content).not.toContain('both');
  });

  it('appends the summary line to the DNS Setup block', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain(
      'Add the records above to your DNS, then run `void domain status foo.example.com` to check progress.',
    );
  });

  it('orders sections CNAME -> ownership', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    const cnameIdx = content.indexOf('CNAME (traffic)');
    const ownershipIdx = content.indexOf('TXT (ownership verification)');
    expect(cnameIdx).toBeGreaterThanOrEqual(0);
    expect(ownershipIdx).toBeGreaterThan(cnameIdx);
  });
});

describe('domainStatus rollup', () => {
  function setupDomain(): void {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
  }

  it('errors when hostname not found on project', async () => {
    mockListDomains.mockResolvedValue([]);

    await runExpectingExit(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockLogError).toHaveBeenCalledWith(
      "domain: Domain 'foo.example.com' not found on this project.",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('renders error state when verification_errors present', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
      verification_errors: ['DNS validation timed out', 'second error'],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   error — Verification failed: DNS validation timed out');
    // Only the first error surfaces in the rollup line.
    expect(statusNote).not.toContain('second error');
  });

  it('renders awaiting_deployment state when bit is true', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'active',
      cf_status: 'active',
      awaiting_deployment: true,
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   awaiting_deployment —');
    expect(statusNote).toContain(
      'Your project has no live deployment yet. Run `void deploy` to bring the domain online.',
    );
  });

  it('renders awaiting_dns state when cf_status=pending and ownership_verification present', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending',
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.foo', value: 'own-token' },
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   awaiting_dns —');
    expect(statusNote).toContain(
      'Cloudflare has not yet observed your _cf-custom-hostname TXT record.',
    );
  });

  it('renders verifying_dns state when cf_status=pending_validation', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   verifying_dns —');
    expect(statusNote).toContain('DNS records found, Cloudflare is validating ownership.');
  });

  it('renders issuing_cert state when cf_status=pending_issuance', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_issuance',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   issuing_cert —');
    expect(statusNote).toContain('Cloudflare is issuing the SSL certificate');
  });

  it("computes 'issuing_cert' for the cert-renewal window (CF active + SSL not active)", async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cf_status: 'active',
      ssl_status: 'pending_validation',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   issuing_cert —');
    expect(statusNote).toContain('Cloudflare is issuing the SSL certificate');
  });

  it("computes 'issuing_cert' over 'active' when DB is active but SSL is re-validating", async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'active' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'active',
      created_at: 'now',
      cf_status: 'active',
      ssl_status: 'pending_validation',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   issuing_cert —');
  });

  it('issuing_cert cites the traffic CNAME and renders it when cname_target is set', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cf_status: 'pending_issuance',
      ssl_status: 'pending_validation',
      cname_target: 'cname.void.app',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   issuing_cert —');
    expect(statusNote).toContain('confirm the traffic CNAME below is published');
    // The CNAME block it cites is actually rendered.
    const allNotes = mockNote.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allNotes).toContain('CNAME (traffic)');
    expect(allNotes).toContain('foo.example.com → cname.void.app');
  });

  it('renders deploying_cert state when cf_status=pending_deployment', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_deployment',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   deploying_cert —');
    expect(statusNote).toContain(
      'SSL certificate issued; Cloudflare is propagating it to its edge.',
    );
  });

  it('renders active state when DB status is active', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'active' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'active',
      created_at: 'now',
      ssl_status: 'active',
      cf_status: 'active',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   active — Live.');
  });

  it('falls back to pending when cf_status and awaiting_deployment are absent (old API)', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain(
      'Status:   pending — Verification pending. Cloudflare is processing.',
    );
  });

  it('error state takes priority over awaiting_deployment and cf_status states', async () => {
    setupDomain();
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
      awaiting_deployment: true,
      verification_errors: ['some failure'],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   error —');
  });
});

describe('computeRollup', () => {
  // Direct table-driven test for the rollup state machine, exercising
  // `computeRollup` without going through `runDomainCommand`. The
  // `domainStatus rollup` block above covers the rendering side
  // (rollup -> note() lines).
  const baseStatus: DomainStatusResponse = {
    id: 'dom_1',
    project_id: 'p',
    hostname: 'h',
    cf_hostname_id: 'cf',
    created_at: 'now',
    status: 'pending',
    ssl_status: 'pending',
    cname_target: 'cname.void.app',
  };

  const cases: Array<[name: string, input: Partial<DomainStatusResponse>, expectedState: string]> =
    [
      [
        'error wins over everything',
        { verification_errors: ['boom'], cf_status: 'active', awaiting_deployment: true },
        'error',
      ],
      [
        'awaiting_deployment beats CF states',
        { awaiting_deployment: true, cf_status: 'pending' },
        'awaiting_deployment',
      ],
      [
        'awaiting_dns on pending + ownership',
        {
          cf_status: 'pending',
          ownership_verification: { type: 'txt', name: 'n', value: 'v' },
        },
        'awaiting_dns',
      ],
      ['verifying_dns', { cf_status: 'pending_validation' }, 'verifying_dns'],
      ['issuing_cert on pending_issuance', { cf_status: 'pending_issuance' }, 'issuing_cert'],
      [
        'issuing_cert on cert-renewal (cf active + ssl pending)',
        { cf_status: 'active', ssl_status: 'pending_validation' },
        'issuing_cert',
      ],
      ['deploying_cert', { cf_status: 'pending_deployment' }, 'deploying_cert'],
      [
        'active when DB active and CF/ssl both active',
        { status: 'active', cf_status: 'active', ssl_status: 'active' },
        'active',
      ],
      ['pending fallback when no signals', {}, 'pending'],
      [
        'active gated on ssl_status — pre-rollout platform during cert renewal',
        { status: 'active', ssl_status: 'pending_validation' },
        'pending',
      ],
      [
        'empty verification_errors does NOT trigger error',
        { verification_errors: [], cf_status: 'pending_validation' },
        'verifying_dns',
      ],
    ];

  for (const [name, input, expectedState] of cases) {
    it(name, () => {
      const rollup = computeRollup({ ...baseStatus, ...input });
      expect(rollup.state).toBe(expectedState);
    });
  }
});

describe('domainStatus --verbose', () => {
  it('renders both rolled-up state and multi-line breakdown', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
      verification_errors: ['boom'],
    });

    await runDomainCommand(
      root,
      args({ subcommand: 'status', hostname: 'foo.example.com', verbose: true }),
    );

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Status:   error —');
    expect(statusNote).toContain('Details:');
    expect(statusNote).toContain('  Status:      pending');
    expect(statusNote).toContain('  SSL Status:  pending_validation');
    expect(statusNote).toContain('  Ownership:   pending');
    expect(statusNote).toContain('  Errors:      boom');
  });

  it('omits the multi-line breakdown when --verbose is not set', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_validation',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).not.toContain('SSL Status:');
    expect(statusNote).not.toContain('Details:');
    expect(statusNote).not.toContain('  Status:      pending');
  });
});

describe('domainStatus pending records block', () => {
  it('shows the traffic CNAME while the cert is still pending (ownership already verified)', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending_issuance',
      cname_target: 'cname.void.app',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('CNAME (traffic)');
    expect(pendingNote).toContain('foo.example.com → cname.void.app');
    // Ownership already verified — CF dropped the TXT, so it must not appear.
    expect(pendingNote).not.toContain('TXT (ownership verification)');
    // One record only: singular title.
    expect(mockNote.mock.calls[1][1]).toBe('Add this DNS record to your provider');
  });

  it('does NOT show the traffic CNAME once the domain is fully active', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'active' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'active',
      created_at: 'now',
      ssl_status: 'active',
      cf_status: 'active',
      cname_target: 'cname.void.app',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    // Only the Domain Status note — the CNAME is correct by definition when live.
    expect(mockNote).toHaveBeenCalledTimes(1);
    expect(mockNote.mock.calls[0][1]).toBe('Domain Status');
    expect(mockNote.mock.calls[0][0] as string).not.toContain('CNAME (traffic)');
  });

  it('shows both records (CNAME before TXT) with a plural title before activation', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending',
      cname_target: 'cname.void.app',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('CNAME (traffic)');
    expect(pendingNote).toContain('foo.example.com → cname.void.app');
    expect(pendingNote).toContain('TXT (ownership verification)');
    expect(pendingNote).toContain('own-name → own-value');
    // HTTP-DCV: no SSL-validation records ever surface to the user.
    expect(pendingNote).not.toContain('TXT (SSL validation)');
    // CNAME ordered before ownership, matching `domain add`.
    expect(pendingNote.indexOf('CNAME (traffic)')).toBeLessThan(
      pendingNote.indexOf('TXT (ownership verification)'),
    );
    // Two records: plural title.
    expect(mockNote.mock.calls[1][1]).toBe('Add these DNS records to your provider');
  });

  it('skips the pending block when status is fully verified', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'active' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'active',
      created_at: 'now',
      ssl_status: 'active',
      cf_status: 'active',
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(1);
    // The single note call is the Domain Status block; no pending block follows.
    expect(mockNote.mock.calls[0][1]).toBe('Domain Status');
  });

  it('exit code stays 0 even when pending', async () => {
    mockListDomains.mockResolvedValue([
      { id: 'dom_1', hostname: 'foo.example.com', status: 'pending' },
    ]);
    mockGetDomainStatus.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      ssl_status: 'pending_validation',
      cf_status: 'pending',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockExit).not.toHaveBeenCalled();
  });
});

describe('domainList', () => {
  it("prints 'No custom domains configured.' info line for empty list", async () => {
    mockListDomains.mockResolvedValue([]);

    await runDomainCommand(root, args({ subcommand: 'list' }));

    expect(mockLogInfo).toHaveBeenCalledWith('No custom domains configured.');
  });
});

describe('domainRemove', () => {
  it('errors with not-found message when hostname not in list', async () => {
    mockListDomains.mockResolvedValue([]);

    await runExpectingExit(root, args({ subcommand: 'delete', hostname: 'foo.example.com' }));

    expect(mockLogError).toHaveBeenCalledWith(
      "domain: Domain 'foo.example.com' not found on this project.",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
