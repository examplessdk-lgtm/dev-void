import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DomainArgs } from '../../src/cli/domain-args.ts';
import { runDomainCommand } from '../../src/cli/domain.ts';

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
const mockListProjects = vi.fn();
const mockAddDomain = vi.fn();
const mockListDomains = vi.fn();
const mockGetDomainStatus = vi.fn();
const mockRemoveDomain = vi.fn();

vi.mock('@clack/prompts', () => ({
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
  mockListProjects.mockReset();
  mockAddDomain.mockReset();
  mockListDomains.mockReset();
  mockGetDomainStatus.mockReset();
  mockRemoveDomain.mockReset();

  mockGetToken.mockReturnValue('test-token');
  mockReadProjectConfig.mockReturnValue({ projectId: 'proj_default', slug: 'default' });
  mockListProjects.mockResolvedValue([]);
  mockListDomains.mockResolvedValue([]);
  delete process.env.VOID_PROJECT;
});

describe('runDomainCommand top-level guards', () => {
  it('fails when no token is found', async () => {
    mockGetToken.mockReturnValue(null);

    await runExpectingExit(root, args({ subcommand: 'list' }));

    expect(mockLogError).toHaveBeenCalledWith('Not logged in. Run `void auth login` first.');
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
  it('prints CNAME + ownership TXT + SSL TXT when all three records returned', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'foo.example.com.cdn.cloudflare.net',
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.foo', value: 'own-token' },
      ssl_validation_records: [{ txt_name: '_acme-challenge.foo', txt_value: 'ssl-token' }],
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(1);
    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).toContain('foo.example.com → foo.example.com.cdn.cloudflare.net');
    expect(content).toContain('TXT (ownership verification)');
    expect(content).toContain('_cf-custom-hostname.foo → own-token');
    expect(content).toContain('TXT (SSL validation)');
    expect(content).toContain('_acme-challenge.foo → ssl-token');
  });

  it('prints multiple SSL records as separate lines under one section', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
      ssl_validation_records: [
        { txt_name: 'a', txt_value: 'b' },
        { txt_name: 'c', txt_value: 'd' },
      ],
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('a → b');
    expect(content).toContain('c → d');
    // Only one SSL section header, despite two records
    expect(content.match(/TXT \(SSL validation\)/g)).toHaveLength(1);
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
      ssl_validation_records: [{ txt_name: 'a', txt_value: 'b' }],
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).toContain('TXT (SSL validation)');
    expect(content).not.toContain('TXT (ownership verification)');
  });

  it('skips SSL section when no record has both txt_name and txt_value', async () => {
    mockAddDomain.mockResolvedValue({
      id: 'dom_1',
      project_id: 'proj_default',
      hostname: 'foo.example.com',
      cf_hostname_id: 'cf_1',
      status: 'pending',
      created_at: 'now',
      cname_target: 'cname.example',
      ssl_validation_records: [{ txt_name: 'a' }],
    });

    await runDomainCommand(root, args({ subcommand: 'add', hostname: 'foo.example.com' }));

    const content = mockNote.mock.calls[0][0] as string;
    expect(content).toContain('CNAME (traffic)');
    expect(content).not.toContain('TXT (SSL validation)');
  });

  it('always prints the `void domain status …` info line', async () => {
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

    expect(mockLogInfo).toHaveBeenCalledWith(
      'Run `void domain status foo.example.com` to check verification progress.',
    );
  });
});

describe('domainStatus', () => {
  it('errors when hostname not found on project', async () => {
    mockListDomains.mockResolvedValue([]);

    await runExpectingExit(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockLogError).toHaveBeenCalledWith(
      "domain: Domain 'foo.example.com' not found on this project.",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('prints `Ownership: pending` when CF returns ownership_verification', async () => {
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
      ownership_verification: { type: 'txt', name: '_cf-custom-hostname.foo', value: 'own-token' },
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).toContain('Ownership:   pending');
  });

  it('omits the Ownership line when CF does not return ownership_verification', async () => {
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
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const statusNote = mockNote.mock.calls[0][0] as string;
    expect(statusNote).not.toContain('Ownership:');
  });

  it('shows pending ownership record ONLY when ownership is pending', async () => {
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
      ssl_status: 'active',
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('TXT (ownership verification)');
    expect(pendingNote).toContain('own-name → own-value');
    expect(pendingNote).not.toContain('TXT (SSL validation)');
  });

  it('shows pending SSL record ONLY when SSL is pending and ownership is verified', async () => {
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
      ssl_validation_records: [{ txt_name: 'ssl-name', txt_value: 'ssl-value' }],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('TXT (SSL validation)');
    expect(pendingNote).toContain('ssl-name → ssl-value');
    expect(pendingNote).not.toContain('TXT (ownership verification)');
  });

  it('shows both records when both pending', async () => {
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
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
      ssl_validation_records: [{ txt_name: 'ssl-name', txt_value: 'ssl-value' }],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(2);
    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('TXT (ownership verification)');
    expect(pendingNote).toContain('own-name → own-value');
    expect(pendingNote).toContain('TXT (SSL validation)');
    expect(pendingNote).toContain('ssl-name → ssl-value');
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
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    expect(mockNote).toHaveBeenCalledTimes(1);
    // The single note call is the Domain Status block; no pending block follows.
    expect(mockNote.mock.calls[0][1]).toBe('Domain Status');
  });

  it('shows multiple SSL records under one section in pending note', async () => {
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
      ssl_validation_records: [
        { txt_name: 'a', txt_value: 'b' },
        { txt_name: 'c', txt_value: 'd' },
      ],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('a → b');
    expect(pendingNote).toContain('c → d');
    expect(pendingNote.match(/TXT \(SSL validation\)/g)).toHaveLength(1);
  });

  it('drops per-record SSL entries already marked active', async () => {
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
      ssl_validation_records: [
        { txt_name: 'done', txt_value: 'done-val', status: 'active' },
        { txt_name: 'pending', txt_value: 'pending-val', status: 'pending_validation' },
      ],
    });

    await runDomainCommand(root, args({ subcommand: 'status', hostname: 'foo.example.com' }));

    const pendingNote = mockNote.mock.calls[1][0] as string;
    expect(pendingNote).toContain('pending → pending-val');
    expect(pendingNote).not.toContain('done → done-val');
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
      ownership_verification: { type: 'txt', name: 'own-name', value: 'own-value' },
      ssl_validation_records: [{ txt_name: 'ssl-name', txt_value: 'ssl-value' }],
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
