import { createPlatformDeploymentManifest } from '@void/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { parsePlatformArgs } from '../../src/cli/platform-args.ts';
import { PlatformCloudflareClient } from '../../src/cli/platform-cloudflare.ts';
import { runPlatformLifecycleCommand } from '../../src/cli/platform-lifecycle.ts';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  plan: vi.fn(),
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  confirm: mocks.confirm,
  select: mocks.select,
  text: mocks.text,
  intro: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
}));
vi.mock('../../src/cli/platform-auth.ts', () => ({
  resolvePlatformCloudflareCredential: async () => ({ source: 'oauth', token: 'test-token' }),
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
