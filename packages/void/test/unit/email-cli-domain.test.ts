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
  isValidEmailDomainInput,
  normalizeEmailDomainInput,
  resolveEmailDomainTarget,
  type CfTokenVerification,
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
const GRANT_SENTINEL = 'grant-refresh-token-placeholder';

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

describe('emailDomainAdd', () => {
  function addDeps(overrides: Partial<EmailDomainAddDeps> = {}): EmailDomainAddDeps {
    return {
      dns: { resolveMx: vi.fn(async () => []) },
      runGrant: vi.fn(async () => ({ refreshToken: GRANT_SENTINEL })),
      isInteractive: true,
      waitForEnter: neverEnter,
      watchIntervalMs: 1,
      watchTimeoutMs: 50,
      exit: exitSpy(),
      ...overrides,
    };
  }

  it('runs the grant and POSTs the refresh token for an MX-empty apex', async () => {
    const addEmailDomain = vi.fn(async () => domainRow({ domain: 'acme.com', mode: 'apex' }));
    const deps = addDeps();

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      deps,
    );

    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      refreshToken: GRANT_SENTINEL,
    });
    expect(printed(infoSpy)).toContain('acme.com has no MX records → using the apex');
    expect(printed(successSpy)).toContain(
      'Grant stored on the platform, encrypted for this project — nothing is kept on this machine.',
    );
    expect(notedBlocks()).toContain('Domain:      acme.com');
    expect(notedBlocks()).toContain('Mode:        apex');
    // The credential never reaches an output.
    expect(printed(infoSpy) + printed(successSpy) + notedBlocks()).not.toContain(GRANT_SENTINEL);
  });

  it('proposes mail.<domain> when the apex carries MX, and says so', async () => {
    const addEmailDomain = vi.fn(async () =>
      domainRow({ domain: 'mail.acme.com', mode: 'subdomain' }),
    );
    const resolveMx = vi.fn(async (name: string) =>
      name === 'acme.com' ? [{ exchange: 'aspmx.l.google.com.', priority: 1 }] : [],
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({ dns: { resolveMx } }),
    );

    expect(printed(infoSpy)).toContain(
      'acme.com carries MX for aspmx.l.google.com → apex is off limits',
    );
    expect(printed(infoSpy)).toContain('using mail.acme.com  [change with --subdomain]');
    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'mail.acme.com',
      refreshToken: GRANT_SENTINEL,
    });
  });

  it('honours an explicit --subdomain and normalizes the positional domain', async () => {
    const addEmailDomain = vi.fn(async () =>
      domainRow({ domain: 'mx.acme.com', mode: 'subdomain' }),
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      '  ACME.com. ',
      'mx',
      addDeps(),
    );

    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'mx.acme.com',
      refreshToken: GRANT_SENTINEL,
    });
  });

  it('refuses an invalid domain or a foreign --subdomain before any grant', async () => {
    const runGrant = vi.fn();
    const addEmailDomain = vi.fn();

    await expect(
      emailDomainAdd(
        { addEmailDomain, getEmailDomain: vi.fn() },
        'prj_1',
        'not a domain',
        undefined,
        addDeps({ runGrant }),
      ),
    ).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain("email: invalid domain 'not a domain'.");

    await expect(
      emailDomainAdd(
        { addEmailDomain, getEmailDomain: vi.fn() },
        'prj_1',
        'acme.com',
        'other.com',
        addDeps({ runGrant }),
      ),
    ).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain('--subdomain must name a subdomain of acme.com');
    expect(runGrant).not.toHaveBeenCalled();
    expect(addEmailDomain).not.toHaveBeenCalled();
  });

  it('refuses to run non-interactively (both grant paths need a human)', async () => {
    const runGrant = vi.fn();
    await expect(
      emailDomainAdd(
        { addEmailDomain: vi.fn(), getEmailDomain: vi.fn() },
        'prj_1',
        'acme.com',
        undefined,
        addDeps({ runGrant, isInteractive: false }),
      ),
    ).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain('needs an interactive terminal');
    expect(runGrant).not.toHaveBeenCalled();
  });

  it('falls back to the template link + clipboard watch when the grant fails', async () => {
    const token = CFUT_TOKEN;
    const clipboard = ['clipboard-before', token];
    let reads = 0;
    const readClipboard = vi.fn(() => clipboard[Math.min(reads++, clipboard.length - 1)]!);
    const clearClipboard = vi.fn();
    const verifyToken = vi.fn(async (): Promise<CfTokenVerification> => 'active');
    const openUrl = vi.fn();
    const addEmailDomain = vi.fn(async () =>
      domainRow({ credential_kind: 'api_token', domain: 'acme.com' }),
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({
        runGrant: vi.fn(async () => {
          throw new Error('cf-oauth: could not start the local callback server on port 8976.');
        }),
        readClipboard,
        clearClipboard,
        verifyToken,
        openUrl,
      }),
    );

    // The failure is named, the link opened, and only the token-shaped NEW
    // clipboard value was verified and POSTed.
    expect(printed(warnSpy)).toContain('could not start the local callback server');
    expect(openUrl).toHaveBeenCalledWith(buildCfApiTokenTemplateUrl('acme.com'));
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(clearClipboard).toHaveBeenCalledTimes(1);
    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: token,
    });
    expect(printed(successSpy)).toContain(
      'Token stored on the platform, encrypted for this project — nothing is kept on this machine.',
    );
    expect(printed(infoSpy) + printed(successSpy) + notedBlocks()).not.toContain(token);
  });

  it('keeps watching past wrong-shape clipboard values without a network call', async () => {
    const values = ['snapshot', 'ghp_' + 'a'.repeat(36), 'not a token', LEGACY_TOKEN];
    let reads = 0;
    const readClipboard = vi.fn(() => values[Math.min(reads++, values.length - 1)]!);
    const verifyToken = vi.fn(async (): Promise<CfTokenVerification> => 'active');
    const addEmailDomain = vi.fn(async () => domainRow({ credential_kind: 'api_token' }));

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({
        runGrant: vi.fn(async () => {
          throw new Error('cf-oauth: cancelled.');
        }),
        readClipboard,
        clearClipboard: vi.fn(),
        verifyToken,
        openUrl: vi.fn(),
      }),
    );

    // One verify — for the only value that passed the shape check.
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: LEGACY_TOKEN,
    });
  });

  it('switches to the masked paste on Enter; a cancel stores nothing', async () => {
    const addEmailDomain = vi.fn(async () => domainRow({ credential_kind: 'api_token' }));
    const pasteToken = vi.fn(async () => `  ${LEGACY_TOKEN}\n`);
    const verifyToken = vi.fn(async (): Promise<CfTokenVerification> => 'active');
    // The grant hangs (it waits on a browser for minutes); Enter resolves at
    // once, so the race deterministically switches paths.
    const pendingGrant = vi.fn(() => new Promise<never>(() => {}));

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({
        runGrant: pendingGrant,
        waitForEnter: vi.fn(async () => {}),
        readClipboard: vi.fn(() => 'clipboard-before'),
        verifyToken,
        pasteToken,
        openUrl: vi.fn(),
        clearClipboard: vi.fn(),
      }),
    );

    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: LEGACY_TOKEN,
    });

    // Esc at the paste prompt: nothing is POSTed, nothing is stored.
    const addEmailDomain2 = vi.fn();
    await emailDomainAdd(
      { addEmailDomain: addEmailDomain2, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({
        runGrant: pendingGrant,
        waitForEnter: vi.fn(async () => {}),
        readClipboard: vi.fn(() => null),
        pasteToken: vi.fn(async () => null),
        openUrl: vi.fn(),
      }),
    );
    expect(addEmailDomain2).not.toHaveBeenCalled();
    expect(printed(infoSpy)).toContain('Cancelled — nothing was stored anywhere.');
  });

  it('stops the clipboard watch once Enter wins — no orphaned poll loop', async () => {
    const addEmailDomain = vi.fn(async () => domainRow({ credential_kind: 'api_token' }));
    // A constant non-token value: the poll loop keeps watching without verifying.
    const readClipboard = vi.fn(() => 'clipboard-before');
    const verifyToken = vi.fn(async (): Promise<CfTokenVerification> => 'active');
    let resolveEnter!: () => void;
    const enterPressed = new Promise<void>((resolve) => {
      resolveEnter = resolve;
    });

    const run = emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps({
        runGrant: vi.fn(async () => {
          throw new Error('cf-oauth: cancelled.');
        }),
        // The first waitForEnter arms the grant race and never fires (the
        // grant's failure ends that race); the second arms the watch race and
        // is fired below, once the poll loop is observably running.
        waitForEnter: vi
          .fn()
          .mockImplementationOnce(neverEnter)
          .mockImplementationOnce(() => enterPressed),
        readClipboard,
        clearClipboard: vi.fn(),
        verifyToken,
        pasteToken: vi.fn(async () => LEGACY_TOKEN),
        openUrl: vi.fn(),
        // Far past the observation window below, so a still-running loop
        // would keep polling through it.
        watchTimeoutMs: 10_000,
      }),
    );

    // The watch is running: the snapshot read plus at least one interval poll.
    await vi.waitFor(() => {
      expect(readClipboard.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    resolveEnter();
    await run;

    // Enter switched to the paste path, which POSTed the pasted token.
    expect(addEmailDomain).toHaveBeenCalledWith('prj_1', {
      domain: 'acme.com',
      apiToken: LEGACY_TOKEN,
    });
    // The settled race stopped the poll loop: no further clipboard reads (so
    // no timer chain and no stray verify from the watch) past this point.
    const readsAtSettle = readClipboard.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30)); // ~30 watch intervals
    expect(readClipboard.mock.calls.length).toBe(readsAtSettle);
    expect(verifyToken).toHaveBeenCalledTimes(1); // the pasted token's check
  });

  it('refuses a pasted token shaped like another vendor’s, without a network call', async () => {
    const verifyToken = vi.fn();
    const addEmailDomain = vi.fn();

    await expect(
      emailDomainAdd(
        { addEmailDomain, getEmailDomain: vi.fn() },
        'prj_1',
        'acme.com',
        undefined,
        addDeps({
          runGrant: vi.fn(() => new Promise<never>(() => {})),
          waitForEnter: vi.fn(async () => {}),
          readClipboard: vi.fn(() => null),
          pasteToken: vi.fn(async () => `ghp_${'a'.repeat(36)}`),
          verifyToken,
          openUrl: vi.fn(),
        }),
      ),
    ).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain('that looks like a different kind of token');
    expect(verifyToken).not.toHaveBeenCalled();
    expect(addEmailDomain).not.toHaveBeenCalled();
  });

  it('refuses a pasted token Cloudflare says is not active', async () => {
    const addEmailDomain = vi.fn();
    await expect(
      emailDomainAdd(
        { addEmailDomain, getEmailDomain: vi.fn() },
        'prj_1',
        'acme.com',
        undefined,
        addDeps({
          runGrant: vi.fn(() => new Promise<never>(() => {})),
          waitForEnter: vi.fn(async () => {}),
          readClipboard: vi.fn(() => null),
          pasteToken: vi.fn(async () => LEGACY_TOKEN),
          verifyToken: vi.fn(async (): Promise<CfTokenVerification> => 'inactive'),
          openUrl: vi.fn(),
        }),
      ),
    ).rejects.toThrow('exit 1');
    expect(printed(errorSpy)).toContain('that is not an active Cloudflare token');
    expect(addEmailDomain).not.toHaveBeenCalled();
  });

  it('renders a failed row with the failed step and the retry hint', async () => {
    const addEmailDomain = vi.fn(async () =>
      domainRow({
        status: 'failed',
        setup_state: { failed_step: 'zone_lookup' },
        error: 'no Cloudflare zone found for acme.com in an account this credential can see',
      }),
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps(),
    );

    expect(printed(errorSpy)).toContain('failed at zone lookup');
    expect(printed(errorSpy)).toContain('no Cloudflare zone found for acme.com');
    expect(printed(infoSpy)).toContain('re-run `void email domain add acme.com`');
  });

  it('renders the pending row with the routing-subdomain dashboard step', async () => {
    const addEmailDomain = vi.fn(async () =>
      domainRow({
        domain: 'mail.acme.com',
        mode: 'subdomain',
        status: 'pending',
        setup_state: { remaining_steps: ['routing_subdomain'] },
      }),
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps(),
    );

    expect(notedBlocks()).toContain('Domain:      mail.acme.com');
    expect(printed(warnSpy)).toContain('Email Routing → acme.com → Settings → Subdomains');
    expect(printed(infoSpy)).toContain('void email domain status mail.acme.com');
  });

  it('renders the Workers Free hint when sending onboarding is still pending on a live row', async () => {
    const addEmailDomain = vi.fn(async () =>
      domainRow({
        status: 'active',
        setup_state: { remaining_steps: ['sending_onboarding'] },
      }),
    );

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain: vi.fn() },
      'prj_1',
      'acme.com',
      undefined,
      addDeps(),
    );

    expect(printed(infoSpy)).toContain('Workers Paid');
    expect(printed(infoSpy)).toContain('void email domain sync acme.com');
    // The row is live — the success line still prints.
    expect(printed(successSpy)).toContain('acme.com is live');
  });

  it('rethrows an API rejection without reconciling — the server already revoked the grant', async () => {
    const addEmailDomain = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to add email domain',
        409,
        '{"error":"domain is registered to another project"}',
      );
    });
    const getEmailDomain = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      emailDomainAdd({ addEmailDomain, getEmailDomain }, 'prj_1', 'acme.com', undefined, addDeps()),
    ).rejects.toThrow(PlatformApiError);
    // No reconciliation, no CLI-side revoke: the API's rejection owns both.
    expect(getEmailDomain).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reconciles a lost answer: the row exists, nothing is revoked', async () => {
    const addEmailDomain = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const getEmailDomain = vi.fn(async () => statusRow({ status: 'pending' }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await emailDomainAdd(
      { addEmailDomain, getEmailDomain },
      'prj_1',
      'acme.com',
      undefined,
      addDeps(),
    );

    // The POST committed and only the answer was lost: the platform holds
    // the credential now, and the row renders like any other add.
    expect(getEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com');
    expect(printed(warnSpy)).toContain('answer was lost');
    expect(notedBlocks()).toContain('Domain:      acme.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('revokes the minted grant when a transport failure provably never persisted it', async () => {
    const addEmailDomain = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const getEmailDomain = vi.fn(async () => {
      throw new PlatformApiError(
        'Failed to fetch email domain status',
        404,
        '{"error":"email domain not found"}',
      );
    });
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      emailDomainAdd({ addEmailDomain, getEmailDomain }, 'prj_1', 'acme.com', undefined, addDeps()),
    ).rejects.toThrow('exit 1');

    // Exactly one call: the RFC 7009 revoke of the grant this process held.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://dash.cloudflare.com/oauth2/revoke');
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('token')).toBe(GRANT_SENTINEL);
    expect(form.get('token_type_hint')).toBe('refresh_token');
    expect(printed(errorSpy)).toContain('was not registered');
    expect(printed(errorSpy)).toContain('revoked');
    // The token itself never reaches an output line.
    expect(printed(errorSpy) + printed(infoSpy) + printed(warnSpy)).not.toContain(GRANT_SENTINEL);
  });

  it('never revokes on an indeterminate reconcile — the grant may be the row’s credential', async () => {
    const addEmailDomain = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const getEmailDomain = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      emailDomainAdd({ addEmailDomain, getEmailDomain }, 'prj_1', 'acme.com', undefined, addDeps()),
    ).rejects.toThrow('exit 1');

    // A blind revoke could brick a committed row — report, don't revoke.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(printed(errorSpy)).toContain('state is unknown');
  });
});

describe('emailDomainStatus', () => {
  it('renders the row, the live credential probe and the relay state', async () => {
    const getEmailDomain = vi.fn(async () =>
      statusRow({ token_id: 'cf-token-id', token_expires_on: '2026-12-31T00:00:00Z' }),
    );
    await emailDomainStatus({ getEmailDomain }, 'prj_1', 'acme.com');

    const block = notedBlocks();
    expect(block).toContain('Domain:      acme.com');
    expect(block).toContain('Mode:        apex');
    expect(block).toContain('Credential:  OAuth grant · active');
    expect(block).toContain('Token:       id cf-token-id · expires 2026-12-31T00:00:00Z');
    expect(block).toContain('Relay:       void-email-relay v1');
    expect(getEmailDomain).toHaveBeenCalledWith('prj_1', 'acme.com');
  });

  it('points at sync when the relay drifted or went missing', async () => {
    await emailDomainStatus(
      {
        getEmailDomain: vi.fn(async () =>
          statusRow({ relay_drift: true, current_relay_version: 2 }),
        ),
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('drifted (current is v2)');
    expect(printed(infoSpy)).toContain('void email domain sync acme.com');

    await emailDomainStatus(
      { getEmailDomain: vi.fn(async () => statusRow({ relay_missing: true })) },
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
      },
      'prj_1',
      'mail.acme.com',
    );
    expect(printed(errorSpy)).toContain('email: probe text safe to print');
    expect(printed(warnSpy)).toContain('Email Routing → acme.com → Settings → Subdomains');
  });

  it('renders the catch-all state, and the sync hint only when it drifted', async () => {
    await emailDomainStatus(
      { getEmailDomain: vi.fn(async () => statusRow({ catch_all: 'points_here' })) },
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
      },
      'prj_1',
      'acme.com',
    );
    expect(notedBlocks()).toContain('Catch-all:   points_elsewhere');
    expect(printed(infoSpy)).toContain('run `void email domain sync acme.com` to re-point it');
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
  it('renders the redeploy + rotation on success', async () => {
    const syncEmailDomain = vi.fn(async () => domainRow({ relay_version: 2 }));
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
    expect(printed(successSpy)).toContain('Relay redeployed at v2 with a rotated secret.');
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
    await emailDomainSync({ syncEmailDomain }, 'prj_1', 'acme.com');
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
    expect(printed(warnSpy)).toContain('NOT overwritten');
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
