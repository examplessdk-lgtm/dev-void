import { createPlatformDeploymentManifest } from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { pc } from '../../src/cli/output.ts';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { loadPlatformRuntime } from '../../src/cli/platform-installer.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  plan: vi.fn(),
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  // These fixtures retain GitHub-only setup; Access choices have their own matrix.
  confirm: (input: { message: string }) =>
    input.message === 'Also protect the platform UI and APIs with Cloudflare Access?'
      ? Promise.resolve(false)
      : mocks.confirm(input),
  multiselect: mocks.multiselect,
  select: mocks.select,
  text: mocks.text,
  intro: vi.fn(),
  note: mocks.note,
  outro: vi.fn(),
}));
vi.mock('../../src/cli/platform-auth.ts', () => ({
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'test-token' }),
  resolvePlatformCloudflareCredentialWithInput: async (input: () => Promise<unknown>) => ({
    input: await input(),
    credential: { source: 'oauth', token: 'test-token' },
  }),
  assertPlatformOperatorCredentialCanApplyPlan: vi.fn(),
}));
vi.mock('../../src/cli/platform-registry.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-registry.ts')>()),
  assertPlatformInstallationSlugAvailable: vi.fn(),
  listInstallationManifests: () => [],
}));
vi.mock('../../src/cli/platform-plan.ts', async (original) => ({
  ...(await original<typeof import('../../src/cli/platform-plan.ts')>()),
  createPlatformInstallPlan: mocks.plan,
}));

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const args = [
  'install',
  '--plan',
  '--name',
  'test',
  '--display-name',
  'Test',
  '--account',
  'account',
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.multiselect.mockResolvedValue(['github']);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PlatformCloudflareClient.prototype, 'listAccounts').mockResolvedValue([
    { id: 'account', name: 'Account' },
  ]);
  mocks.text.mockResolvedValue('');
  mocks.select.mockResolvedValue('workers-dev');
  mocks.confirm.mockResolvedValue(false);
  mocks.plan.mockResolvedValue({
    account: { id: 'account', name: 'Account' },
    actions: [],
    apiUrl: 'https://api.test.workers.dev',
    proxyUrl: 'https://proxy.test.workers.dev',
    deployment: createPlatformDeploymentManifest({
      installationSlug: 'test',
      displayName: 'Test',
      application: { baseDomain: 'example.com', zoneName: 'example.com' },
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (ttyDescriptor) {
    Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
});

describe('interactive platform installation prompts', () => {
  it('bolds platform runtime labels without styling their values', async () => {
    vi.spyOn(pc, 'bold').mockImplementation(pc.createColors(true).bold);
    const runtime = loadPlatformRuntime('');
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, '--workers-dev']));
    expect(mocks.note).toHaveBeenCalledWith(
      [
        `\u001b[1mVersion:\u001b[22m ${runtime.manifest.platformVersion}`,
        `\u001b[1mSource:\u001b[22m ${runtime.source}`,
        `\u001b[1mRevision:\u001b[22m ${runtime.manifest.sourceRevision ?? 'not recorded'}`,
        `\u001b[1mManifest SHA-256:\u001b[22m ${runtime.manifestSha256}`,
      ].join('\n'),
      'Platform runtime',
    );
  });

  it('uses a placeholder, not a prefilled installation name', async () => {
    mocks.text.mockResolvedValueOnce('my-team');
    await runPlatformLifecycleCommand(
      parsePlatformArgs(['install', '--plan', '--account', 'account', '--workers-dev']),
    );
    const prompt = mocks.text.mock.calls[0]![0];
    expect(prompt).toMatchObject({ message: 'Installation name:', placeholder: 'company' });
    expect(prompt).not.toHaveProperty('initialValue');
    expect(prompt.validate('')).toBe('A value is required.');
    expect(prompt.validate('my-team')).toBeUndefined();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ installationSlug: 'my-team' }),
      null,
      expect.anything(),
    );
    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Platform display name:',
        initialValue: 'my-team Void',
      }),
    );
  });

  it.each([
    { name: 'explicit flag', flags: ['--workers-dev'] },
    { name: 'interactive selection', flags: [] },
  ])('skips the dedicated-zone question for testing mode: $name', async ({ flags }) => {
    await runPlatformLifecycleCommand(parsePlatformArgs([...args, ...flags]));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workersDev: true, zoneName: '', dedicatedZone: false }),
      null,
      expect.anything(),
    );
  });

  it('keeps the named catch-all choice for an application domain at the zone apex', async () => {
    mocks.confirm.mockResolvedValue(true);
    await runPlatformLifecycleCommand(
      parsePlatformArgs([...args, '--application-domain', 'example.com', '--zone', 'example.com']),
    );
    expect(mocks.confirm).toHaveBeenCalledWith({
      message: 'Dedicate all unmatched example.com traffic to Void apps?',
      initialValue: false,
    });
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dedicatedZone: true }),
      null,
      expect.anything(),
    );
  });

  it('does not offer zone-wide routing for a nested application domain', async () => {
    await runPlatformLifecycleCommand(
      parsePlatformArgs([
        ...args,
        '--application-domain',
        'apps.example.com',
        '--zone',
        'example.com',
      ]),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
