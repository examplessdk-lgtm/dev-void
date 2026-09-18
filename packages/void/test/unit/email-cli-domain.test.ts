import { log, note } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  PlatformApiError,
  PlatformClient,
  type EmailDomainResponse,
  type EmailDomainStatusResponse,
  type RemoveEmailDomainResponse,
} from '../../src/cli/client.ts';
import {
  buildCfApiTokenTemplateUrl,
  classifyCfApiTokenShape,
  emailDomainAdd,
  emailDomainList,
  emailDomainRemove,
  emailDomainStatus,
  emailDomainSync,
  emailDomainRotateSecret,
  isValidEmailDomainInput,
  normalizeEmailDomainInput,
  resolveEmailDomainTarget,
  type EmailDomainAddDeps,
} from '../../src/cli/email.ts';

/**
 * `void email domain …` (design doc 0078, "Custom domains on Cloudflare").
 * Every browser, clipboard, DNS and stdin touch is a seam; credential values
 * here are inert placeholders and are never printed.
 */

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, note: vi.fn() };
});

const LEGACY_TOKEN = `Lgcy-${'a1'.repeat(17)}B`; // 40 chars, [A-Za-z0-9_-]
const CFUT_TOKEN = `cfut_${'c0'.repeat(20)}${'deed'.repeat(2)}`; // 40-char core + checksum tail
/** The default platform: owners register their own domains. */
const selfServeSettings = async (): Promise<{
  domains: { management: 'self-serve' | 'admin' };
}> => ({ domains: { management: 'self-serve' } });
const noEmailDomains = async (): Promise<Array<EmailDomainResponse>> => [];

type LogSpy = ReturnType<typeof vi.spyOn>;

let successSpy: LogSpy;
let infoSpy: LogSpy;
let warnSpy: LogSpy;
let errorSpy: LogSpy;

beforeEach(() => {
  successSpy = vi.spyOn(log, 'success').mockImplementation(() => {});
  infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
  // Silenced, never asserted: the CI-mode spinner writes through log.step.
  vi.spyOn(log, 'step').mockImplementation(() => {});
  vi.mocked(note).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function printed(spy: LogSpy): string {
  return (spy.mock.calls as Array<Array<unknown>>).map((call) => String(call[0])).join('\n');
}

function notedBlocks(): string {
  return vi
    .mocked(note)
    .mock.calls.map((call) => String(call[0]))
    .join('\n');
}

function domainRow(overrides: Partial<EmailDomainResponse> = {}): EmailDomainResponse {
  return {
    id: 'edom_1',
    domain: 'acme.com',
    mode: 'apex',
    status: 'active',
    credential_kind: 'oauth_grant',
    relay_worker_name: 'void-email-relay',
    relay_version: 1,
    token_id: null,
    token_expires_on: null,
    setup_state: null,
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
    ...overrides,
  };
}

function statusRow(overrides: Partial<EmailDomainStatusResponse> = {}): EmailDomainStatusResponse {
  return {
    ...domainRow(),
    credential_status: 'active',
    current_relay_version: 1,
    relay_drift: false,
    relay_missing: false,
    catch_all: 'points_here',
    catch_all_drift: false,
    ...overrides,
  };
}

/** exit seam: throws so the command stops the way process.exit would. */
function exitSpy(): (code: number) => never {
  return vi.fn((code: number): never => {
    throw new Error(`exit ${code}`);
  });
}

function neverEnter(): Promise<never> {
  return new Promise<never>(() => {});
}

describe('buildCfApiTokenTemplateUrl', () => {
  it('carries the five pinned permission groups, wildcard resources and the domain name', () => {
    const url = new URL(buildCfApiTokenTemplateUrl('acme.com'));
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'zone', type: 'read' },
      { key: 'email_routing_rule', type: 'edit' },
      { key: 'email_sending', type: 'edit' },
      { key: 'workers_scripts', type: 'edit' },
      { key: 'zone_settings', type: 'edit' },
    ]);
    expect(url.searchParams.get('accountId')).toBe('*');
    expect(url.searchParams.get('zoneId')).toBe('all');
    // The em dash survives the round trip through percent-encoding.
    expect(url.searchParams.get('name')).toBe('Void email — acme.com');
  });
});

describe('classifyCfApiTokenShape', () => {
  it('accepts the cfut_ format (prefix + 40 chars + checksum)', () => {
    expect(classifyCfApiTokenShape(CFUT_TOKEN)).toBe('cfut');
    // Checksum length is bounded loosely — the docs pin the 40, not the tail.
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(44)}`)).toBe('cfut');
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(64)}`)).toBe('cfut');
  });

  it('accepts the legacy 40-character form, trimmed', () => {
    expect(classifyCfApiTokenShape(LEGACY_TOKEN)).toBe('legacy');
    expect(classifyCfApiTokenShape(`  ${LEGACY_TOKEN}\n`)).toBe('legacy');
  });

  it('refuses other vendor prefixes and the CF global key without a network call', () => {
    for (const value of [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'a'.repeat(30)}`,
      `sk-proj-${'a'.repeat(30)}`,
      `sk-${'a'.repeat(40)}`,
      `xoxb-${'1'.repeat(20)}`,
      `xoxp-${'1'.repeat(20)}`,
      `cfk_${'a'.repeat(48)}`,
    ]) {
      expect(classifyCfApiTokenShape(value)).toBe('refused');
    }
  });

  it('rejects everything else as unknown', () => {
    expect(classifyCfApiTokenShape('')).toBe('unknown');
    expect(classifyCfApiTokenShape('   ')).toBe('unknown');
    expect(classifyCfApiTokenShape('hello world')).toBe('unknown');
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(43)}`)).toBe('unknown'); // core + no checksum
    expect(classifyCfApiTokenShape(`cfut_${'a'.repeat(65)}`)).toBe('unknown');
    expect(classifyCfApiTokenShape('a'.repeat(39))).toBe('unknown');
    expect(classifyCfApiTokenShape('a'.repeat(41))).toBe('unknown');
    // An account-token prefix is not accepted — the shape check only passes
    // user tokens; anything else is the platform's to refuse.
    expect(classifyCfApiTokenShape(`cfat_${'a'.repeat(48)}`)).toBe('unknown');
    // Legacy shape tolerates no whitespace inside.
    expect(classifyCfApiTokenShape(`${'a'.repeat(20)} ${'a'.repeat(19)}`)).toBe('unknown');
  });
});

describe('domain input helpers', () => {
  it('normalizes like the api (trim, lowercase, strip trailing dot)', () => {
    expect(normalizeEmailDomainInput('  ACME.com. ')).toBe('acme.com');
    expect(isValidEmailDomainInput('acme.com')).toBe(true);
    expect(isValidEmailDomainInput('mail.acme.com')).toBe(true);
    expect(isValidEmailDomainInput('not a domain')).toBe(false);
    expect(isValidEmailDomainInput('-bad.com')).toBe(false);
    expect(isValidEmailDomainInput('nodot')).toBe(false);
  });

  it('resolves --subdomain labels and hosts under the positional domain', () => {
    expect(resolveEmailDomainTarget('acme.com', undefined)).toEqual({
      emailDomain: 'acme.com',
      forced: false,
    });
    expect(resolveEmailDomainTarget('acme.com', 'mx')).toEqual({
      emailDomain: 'mx.acme.com',
      forced: true,
    });
    expect(resolveEmailDomainTarget('acme.com', 'mail.acme.com.')).toEqual({
      emailDomain: 'mail.acme.com',
      forced: true,
    });
    expect(() => resolveEmailDomainTarget('acme.com', 'acme.com')).toThrow(
      /must name a subdomain of acme.com/,
    );
    expect(() => resolveEmailDomainTarget('acme.com', 'other.com')).toThrow(
      /must name a subdomain of acme.com/,
    );
    expect(() => resolveEmailDomainTarget('acme.com', '!!!')).toThrow(/invalid --subdomain value/);
  });
});

describe('PlatformClient.getEmailSettings', () => {
  function clientWith(status: number, body: string) {
    const fetchSpy = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetchSpy);
    return new PlatformClient('jwt-dummy', 'https://api.example.test');
  }

  it('reads the settings the platform reports', async () => {
    const client = clientWith(
      200,
      JSON.stringify({ domains: { management: 'admin', projectSlug: 'hr-portal' } }),
    );
    await expect(client.getEmailSettings('prj_1')).resolves.toMatchObject({
      domains: { management: 'admin', projectSlug: 'hr-portal' },
    });
  });

  it('treats a platform without the route as self-serve, but a missing project as an error', async () => {
    await expect(clientWith(404, '404 Not Found').getEmailSettings('prj_1')).resolves.toEqual({
      domains: { management: 'self-serve' },
    });
    await expect(
      clientWith(404, JSON.stringify({ error: 'project not found' })).getEmailSettings('prj_gone'),
    ).rejects.toThrow(PlatformApiError);
  });
});

describe('emailDomainAdd', () => {
  const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
  function addDeps(overrides: Partial<EmailDomainAddDeps> = {}): EmailDomainAddDeps {
    return {
      dns: { resolveMx: vi.fn(async () => []) },
      isInteractive: true,
      openUrl: vi.fn(),
      readClipboard: () => null,
      clearClipboard: vi.fn(),
      pasteToken: vi.fn(async () => LEGACY_TOKEN),
      confirmScope: vi.fn(async () => true),
      verifyToken: vi.fn(async () => 'active' as const),
      waitForEnter: neverEnter,
      watchIntervalMs: 1,
      watchTimeoutMs: 40,
      sleep: vi.fn(async () => {}),
      exit: exitSpy(),
      ...overrides,
    };
  }
  function client() {
    return {
      addEmailDomain: vi.fn(async () => domainRow({ credential_kind: 'api_token' })),
      getEmailDomain: vi.fn(async () => statusRow()),
      getEmailOperation: vi.fn(async () => ({
        operationId: 'op_1',
        attemptId: ATTEMPT_ID,
        status: 'completed' as const,
        domain: 'acme.com',
        readiness: {
          inbound: { status: 'ready' as const },
          outbound: { status: 'ready' as const },
          management: { status: 'healthy' as const },
        },
      })),
      getEmailSettings: vi.fn(selfServeSettings),
      listEmailDomains: vi.fn(noEmailDomains),
    };
  }

  it('uses scoped API-token setup and submits no OAuth grant', async () => {
    const api = client();
    const deps = addDeps();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(ATTEMPT_ID);
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps);
    expect(api.addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: LEGACY_TOKEN,
      attemptId: ATTEMPT_ID,
    });
    expect(deps.openUrl).toHaveBeenCalledWith(expect.stringContaining('/profile/api-tokens?'));
    expect(deps.confirmScope).toHaveBeenCalledWith('acme.com');
    expect(printed(infoSpy)).toContain('replace All accounts and All zones');
    expect(printed(successSpy)).toContain('zone connection');
    expect([printed(infoSpy), printed(successSpy), notedBlocks()].join('')).not.toContain(
      LEGACY_TOKEN,
    );
  });

  it('does not submit a token whose scope was not confirmed', async () => {
    const api = client();
    await expect(
      emailDomainAdd(
        api,
        'prj_1',
        'acme.com',
        undefined,
        addDeps({ confirmScope: async () => false }),
      ),
    ).rejects.toThrow('exit 1');
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('chooses a mail subdomain when the apex already receives mail', async () => {
    const api = client();
    const resolveMx = vi.fn(async (name: string) =>
      name === 'acme.com' ? [{ exchange: 'mx.example.net', priority: 10 }] : [],
    );
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, addDeps({ dns: { resolveMx } }));
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ domain: 'mail.acme.com' }),
    );
  });

  it('honors an explicitly selected mail subdomain', async () => {
    const api = client();
    await emailDomainAdd(api, 'prj_1', 'acme.com', 'notifications', addDeps());
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ domain: 'notifications.acme.com' }),
    );
  });

  it('rejects invalid domains before opening a browser', async () => {
    const api = client();
    const deps = addDeps();
    await expect(emailDomainAdd(api, 'prj_1', 'https://acme.com', undefined, deps)).rejects.toThrow(
      'exit 1',
    );
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('hands new administrator-managed domains to the operator without a token flow', async () => {
    const api = client();
    const deps = addDeps();
    api.getEmailSettings.mockResolvedValue({ domains: { management: 'admin' } });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps)).rejects.toThrow(
      'exit 0',
    );
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(deps.pasteToken).not.toHaveBeenCalled();
    expect(printed(infoSpy)).toContain('void platform email domain-add acme.com --project prj_1');
  });

  it('lets an owner renew their earlier assignment after the administrator mode switch', async () => {
    const api = client();
    const deps = addDeps();
    api.getEmailSettings.mockResolvedValue({ domains: { management: 'admin' } });
    api.listEmailDomains.mockResolvedValue([domainRow({ managed_by: 'owner' })]);
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps);
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ domain: 'acme.com', apiToken: LEGACY_TOKEN }),
    );
    expect(deps.dns?.resolveMx).not.toHaveBeenCalled();
  });

  it('fails non-interactive setup without opening a browser', async () => {
    const api = client();
    const deps = addDeps({ isInteractive: false });
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps)).rejects.toThrow(
      'exit 1',
    );
    expect(deps.openUrl).not.toHaveBeenCalled();
  });

  it('cancels masked paste without storing a credential', async () => {
    const api = client();
    const deps = addDeps({ pasteToken: async () => null });
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps);
    expect(api.addEmailDomain).not.toHaveBeenCalled();
    expect(deps.confirmScope).not.toHaveBeenCalled();
  });

  it.each(['ghp_not-a-cloudflare-token', 'not-a-token'])(
    'rejects foreign or malformed credential %s locally',
    async (token) => {
      const api = client();
      const deps = addDeps({ pasteToken: async () => token });
      await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps)).rejects.toThrow(
        'exit 1',
      );
      expect(deps.verifyToken).not.toHaveBeenCalled();
      expect(api.addEmailDomain).not.toHaveBeenCalled();
    },
  );

  it('refuses an inactive token', async () => {
    const api = client();
    await expect(
      emailDomainAdd(
        api,
        'prj_1',
        'acme.com',
        undefined,
        addDeps({ verifyToken: async () => 'inactive' }),
      ),
    ).rejects.toThrow('exit 1');
    expect(api.addEmailDomain).not.toHaveBeenCalled();
  });

  it('leaves authoritative verification to the API if the local token probe is unavailable', async () => {
    const api = client();
    await emailDomainAdd(
      api,
      'prj_1',
      'acme.com',
      undefined,
      addDeps({ verifyToken: async () => 'unknown' }),
    );
    expect(api.addEmailDomain).toHaveBeenCalled();
  });

  it('accepts only a new Cloudflare-shaped clipboard value and clears it after use', async () => {
    const api = client();
    const readClipboard = vi
      .fn()
      .mockReturnValueOnce('old clipboard')
      .mockReturnValueOnce('ghp_ignored')
      .mockReturnValue(CFUT_TOKEN);
    const deps = addDeps({ readClipboard });
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, deps);
    expect(deps.verifyToken).toHaveBeenCalledTimes(1);
    expect(deps.verifyToken).toHaveBeenCalledWith(CFUT_TOKEN);
    expect(deps.clearClipboard).toHaveBeenCalledTimes(1);
    expect(api.addEmailDomain).toHaveBeenCalledWith(
      'prj_1',
      expect.objectContaining({ apiToken: CFUT_TOKEN }),
    );
  });

  it('recovers a lost submission response by exact operation key', async () => {
    const api = client();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(ATTEMPT_ID);
    api.addEmailDomain.mockRejectedValue(new Error('connection reset'));
    await emailDomainAdd(api, 'prj_1', 'acme.com', undefined, addDeps());
    expect(api.getEmailOperation).toHaveBeenCalledWith('prj_1', ATTEMPT_ID);
    expect(api.getEmailDomain).not.toHaveBeenCalled();
    expect(notedBlocks()).toContain('Operation:   op_1');
    expect(notedBlocks()).toContain('Inbound:     ready');
    expect(notedBlocks()).not.toContain('[object Object]');
  });

  it('never treats missing operation reads as proof that nothing committed', async () => {
    const api = client();
    api.addEmailDomain.mockRejectedValue(new Error('connection reset'));
    api.getEmailOperation.mockRejectedValue(new PlatformApiError('not found', 404, '{}'));
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, addDeps())).rejects.toThrow(
      'exit 1',
    );
    expect(api.getEmailOperation).toHaveBeenCalledTimes(15);
    expect(printed(errorSpy)).toContain('outcome is unknown');
    expect(printed(errorSpy)).toContain('Nothing was revoked');
  });

  it('does not poll after a definitive validation refusal', async () => {
    const api = client();
    api.addEmailDomain.mockRejectedValue(new PlatformApiError('invalid domain', 400, '{}'));
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, addDeps())).rejects.toThrow(
      'invalid domain',
    );
    expect(api.getEmailOperation).not.toHaveBeenCalled();
  });

  it('returns failure for setup needing intervention, even if a row exists', async () => {
    const api = client();
    api.addEmailDomain.mockResolvedValue(
      domainRow({
        status: 'failed',
        operationId: 'op_1',
        operationStatus: 'blocked',
        error: 'catch-all conflict',
      }),
    );
    await expect(emailDomainAdd(api, 'prj_1', 'acme.com', undefined, addDeps())).rejects.toThrow(
      'exit 1',
    );
    expect(printed(errorSpy)).toContain('catch-all conflict');
  });
});

describe('emailDomainStatus', () => {
  it('renders the row, the live credential probe and the relay state', async () => {
    const getEmailDomain = vi.fn(async () =>
      statusRow({ token_id: 'cf-token-id', token_expires_on: '2026-12-31T00:00:00Z' }),
    );
    const getEmailSettings = vi.fn(selfServeSettings);
    await emailDomainStatus({ getEmailDomain, getEmailSettings }, 'prj_1', 'acme.com');

    const block = notedBlocks();
    expect(block).toContain('Domain:      acme.com');
    expect(block).toContain('Mode:        apex');
    expect(block).toContain('Credential:  OAuth grant · active');
    expect(block).toContain('Token:       id cf-token-id · expires 2026-12-31T00:00:00Z');
    expect(block).toContain('Relay:       void-email-relay v1');
    expect(getEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com');
    expect(getEmailSettings).not.toHaveBeenCalled();
  });

  it('points at sync when the relay drifted or went missing', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({ relay_drift: true, current_relay_version: 2 }),
        ),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('drifted (current is v2)');
    expect(printed(infoSpy)).toContain('void email domain sync acme.com');

    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () => statusRow({ relay_missing: true })),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('missing from the account');
  });

  it('names the renewal path for a revoked or expired credential', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({ status: 'token_revoked', credential_status: 'revoked' }),
        ),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(printed(warnSpy)).toContain('Re-run `void email domain add acme.com`');
    expect(printed(warnSpy)).toContain('adding again replaces the credential, rules stay');
  });

  it('prints the api error verbatim and the remaining human step', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({
            status: 'pending',
            mode: 'subdomain',
            domain: 'mail.acme.com',
            error: 'probe text safe to print',
            setup_state: { remaining_steps: ['routing_subdomain'] },
          }),
        ),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'mail.acme.com',
    );
    expect(printed(errorSpy)).toContain('email: probe text safe to print');
    expect(printed(warnSpy)).toContain('Email Routing → acme.com → Settings → Subdomains');
  });

  it('renders the catch-all state, and the sync hint only when it drifted', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () => statusRow({ catch_all: 'points_here' })),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('Catch-all:   points_here');
    expect(printed(infoSpy)).not.toContain('re-point it');

    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({ catch_all: 'points_elsewhere', catch_all_drift: true }),
        ),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('Catch-all:   points_elsewhere');
    expect(printed(infoSpy)).toContain('run `void email domain sync acme.com` to re-point it');
  });

  it('points administrator-managed setup and drift remediation at the administrator', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({
            managed_by: 'admin',
            status: 'pending',
            mode: 'subdomain',
            domain: 'mail.acme.com',
            relay_drift: true,
            catch_all: 'points_elsewhere',
            catch_all_drift: true,
            setup_state: { remaining_steps: ['routing_subdomain'] },
          }),
        ),
        getEmailSettings: selfServeSettings,
      },
      'prj_1',
      'mail.acme.com',
    );

    expect(printed(warnSpy)).toContain(
      "One step for your administrator, in the platform's Cloudflare account",
    );
    expect(printed(infoSpy)).toContain('void platform email domain-sync mail.acme.com');
    expect(printed(infoSpy)).not.toContain('void email domain sync');
  });

  it.each([
    ['platform credential', 'platform' as const, false],
    ['pasted API token', 'api_token' as const, true],
  ])(
    'points failed administrator setup using a %s at domain-add',
    async (_label, kind, tokenStdin) => {
      const getEmailSettings = vi.fn(async () => ({
        domains: { management: 'admin' as const, projectSlug: 'hr-portal' },
      }));
      await emailDomainStatus(
        {
          getEmailDomain: vi.fn(async () =>
            statusRow({
              managed_by: 'admin',
              credential_kind: kind,
              status: 'failed',
              relay_worker_name: null,
              relay_version: null,
              relay_drift: true,
              catch_all_drift: true,
              setup_state: { failed_step: 'zone_lookup' },
            }),
          ),
          getEmailSettings,
        },
        'prj_1',
        'acme.com',
      );

      const output = printed(warnSpy) + printed(infoSpy);
      expect(output).toContain('void platform email domain-add acme.com --project hr-portal');
      expect(output.includes('--token-stdin')).toBe(tokenStdin);
      expect(output).not.toContain('domain-sync');
      expect(getEmailSettings).toHaveBeenCalledTimes(1);
    },
  );

  it('points an expired administrator API token at platform domain-add with the project slug', async () => {
    const getEmailSettings = vi.fn(async () => ({
      domains: { management: 'admin' as const, projectSlug: 'hr-portal' },
    }));
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({
            managed_by: 'admin',
            credential_kind: 'api_token',
            status: 'token_expired',
            credential_status: 'expired',
          }),
        ),
        getEmailSettings,
      },
      'prj_1',
      'acme.com',
    );

    expect(printed(warnSpy)).toContain(
      'void platform email domain-add acme.com --project hr-portal --token-stdin',
    );
    expect(getEmailSettings).toHaveBeenCalledWith('prj_1');
  });
});

describe('emailDomainList', () => {
  it('reports the empty state with the add hint', async () => {
    await emailDomainList({ listEmailDomains: vi.fn(async () => []) }, 'prj_1');
    expect(printed(infoSpy)).toContain('No email domains.');
    expect(printed(infoSpy)).toContain('void email domain add <domain>');
  });

  it('renders one line per domain with status and mode', async () => {
    await emailDomainList(
      {
        listEmailDomains: vi.fn(async () => [
          domainRow({ domain: 'acme.com', status: 'active', mode: 'apex' }),
          domainRow({
            id: 'edom_2',
            domain: 'mail.example.org',
            status: 'pending',
            mode: 'subdomain',
          }),
        ]),
      },
      'prj_1',
    );
    const block = notedBlocks();
    expect(block).toContain('acme.com');
    expect(block).toContain('mail.example.org');
    expect(block).toContain('subdomain');
  });
});

describe('emailDomainSync', () => {
  it('renders reconciliation without claiming automatic secret rotation', async () => {
    const syncEmailDomain = vi.fn(async () => domainRow({ relay_version: 2 }));
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(printed(successSpy)).not.toContain('rotated secret');
    expect(notedBlocks()).toContain('acme.com');
    expect(syncEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com');
  });

  it('renders a failed sync with the failed step', async () => {
    const syncEmailDomain = vi.fn(async () =>
      domainRow({
        status: 'failed',
        relay_version: null,
        setup_state: { failed_step: 'deploy_relay' },
        error: 'PUT script failed',
      }),
    );
    await expect(emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com')).rejects.toThrow(
      'reconciliation',
    );
    expect(printed(errorSpy)).toContain('failed at deploy relay');
    expect(printed(errorSpy)).toContain('PUT script failed');
    expect(printed(successSpy)).not.toContain('Relay redeployed');
  });

  it('prints the catch-all outcome when the response carries one', async () => {
    const syncEmailDomain = vi.fn(async () => ({ ...domainRow(), catch_all: 'ensured' as const }));
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(printed(infoSpy)).toContain('Catch-all: ensured');
    expect(printed(warnSpy)).not.toContain('NOT overwritten');
  });

  it('warns instead of claiming the catch-all when it points at a different worker', async () => {
    const syncEmailDomain = vi.fn(async () => ({
      ...domainRow(),
      catch_all: 'foreign_conflict' as const,
    }));
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(printed(warnSpy)).toContain("the zone's catch-all points at a different worker");
    expect(printed(warnSpy)).toContain('not overwritten');
    expect(printed(infoSpy)).not.toContain('Catch-all:');
  });

  it('prints no catch-all line when the response omits it (a row with no zone_id)', async () => {
    const syncEmailDomain = vi.fn(async () => domainRow());
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(printed(infoSpy) + printed(warnSpy)).not.toContain('Catch-all');
  });
});

describe('emailDomainRemove', () => {
  function removeClient(body: RemoveEmailDomainResponse): Pick<
    PlatformClient,
    'removeEmailDomain'
  > & {
    removeEmailDomain: ReturnType<typeof vi.fn>;
  } {
    return { removeEmailDomain: vi.fn(async () => body) };
  }

  it('renders a clean removal with no warnings', async () => {
    const client = removeClient({ ok: true, removed: true });
    await emailDomainRemove(client, 'prj_1', 'acme.com');
    expect(client.removeEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com', undefined);
    expect(printed(successSpy)).toContain(
      'Removed acme.com — the platform row, the stored credential and the relay secret are gone.',
    );
    expect(printed(warnSpy)).toBe('');
    expect(printed(errorSpy)).toBe('');
  });

  it('passes --force through to the api', async () => {
    const client = removeClient({ ok: true, removed: true });
    await emailDomainRemove(client, 'prj_1', 'acme.com', { force: true });
    expect(client.removeEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com', true);
  });

  it('kept for retry: names the failed steps, points at retry and --force, exits 1', async () => {
    const client = removeClient({
      ok: false,
      removed: false,
      failed_steps: ['catch_all', 'delete_relay'],
    });
    const exit = exitSpy();
    await expect(emailDomainRemove(client, 'prj_1', 'acme.com', { exit })).rejects.toThrow(
      'exit 1',
    );
    expect(printed(errorSpy)).toContain('failed Cloudflare-side steps: catch_all, delete_relay');
    expect(printed(infoSpy)).toContain('The registration was kept');
    expect(printed(infoSpy)).toContain('retry `void email domain remove acme.com`');
    expect(printed(infoSpy)).toContain('re-run with --force to drop the row anyway');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forced: success plus a warning naming the failed steps and the manual cleanup', async () => {
    const client = removeClient({
      ok: true,
      removed: true,
      forced: true,
      failed_steps: ['delete_relay', 'catch_all'],
    });
    await emailDomainRemove(client, 'prj_1', 'acme.com', { force: true });
    expect(printed(successSpy)).toContain('Removed acme.com');
    expect(printed(warnSpy)).toContain('delete_relay, catch_all');
    expect(printed(warnSpy)).toContain('delete the relay worker and reset the catch-all');
    expect(printed(warnSpy)).toContain("the zone's Email Routing settings");
  });

  it('a grant-revoke failure alone is a one-line note, not a warning', async () => {
    const client = removeClient({ ok: true, removed: true, failed_steps: ['revoke_grant'] });
    await emailDomainRemove(client, 'prj_1', 'acme.com');
    expect(printed(successSpy)).toContain('Removed acme.com');
    expect(printed(infoSpy)).toContain('the Cloudflare grant could not be revoked');
    expect(printed(infoSpy)).toContain('no mail impact');
    expect(printed(warnSpy)).toBe('');
  });
});

describe('PlatformClient.removeEmailDomain', () => {
  const apiUrl = 'https://api.test';
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it('DELETEs the domain URL, appending ?force=1 only when forced', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, removed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const client = new PlatformClient('tok', { apiUrl });

    await client.removeEmailDomain('prj_1', 'acme.com');
    const [plainUrl, plainInit] = fetchMock.mock.calls[0]!;
    expect(String(plainUrl)).toBe(`${apiUrl}/projects/prj_1/email/domains/acme.com`);
    expect(plainInit?.method).toBe('DELETE');

    await client.removeEmailDomain('prj_1', 'acme.com', true);
    const [forceUrl, forceInit] = fetchMock.mock.calls[1]!;
    expect(String(forceUrl)).toBe(`${apiUrl}/projects/prj_1/email/domains/acme.com?force=1`);
    expect(forceInit?.method).toBe('DELETE');
  });
});

describe('emailDomainRotateSecret', () => {
  it('prints completion only after the deployed generation is confirmed', async () => {
    const rotateEmailDomainSecret = vi.fn(async () =>
      domainRow({ operationId: 'eop_rotate', operationStatus: 'completed' }),
    );
    await emailDomainRotateSecret({ rotateEmailDomainSecret }, 'prj_1', 'acme.com');
    expect(rotateEmailDomainSecret).toHaveBeenCalledWith('prj_1', 'acme.com');
    expect(printed(successSpy)).toContain('verified on the deployed Worker');
  });
  it('surfaces an uncertain rotation instead of reporting success', async () => {
    const rotateEmailDomainSecret = vi.fn(async () =>
      domainRow({ operationId: 'eop_rotate', operationStatus: 'unknown' }),
    );
    await expect(
      emailDomainRotateSecret({ rotateEmailDomainSecret }, 'prj_1', 'acme.com'),
    ).rejects.toThrow('eop_rotate');
    expect(printed(successSpy)).not.toContain('secret rotated');
  });
});
