import { readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyEmailSetup,
  deriveAddresses,
  emailFromDomain,
  fetchWithSessionBearer,
  parseRoutingRules,
  parseRoutingSettings,
  parseSendingSettings,
  parseWhoamiJson,
  preflightEmail,
  renderAddressMap,
  renderEmailChecklist,
  SUBDOMAIN_DASHBOARD_FALLBACK,
  SENDING_FREE_PLAN_HINT,
  WRANGLER_EMAIL_PROSE_VERSION,
  wranglerApiErrorCode,
  type EmailCloudflareInputs,
  type EmailDns,
  type EmailWranglerRunResult,
} from '../../src/cli/email-cloudflare.ts';
import type { EmailHandlersScan } from '../../src/router/email.ts';
import { compileEmailPattern } from '../../src/router/email.ts';

// ── Fixtures: verbatim stdout/stderr of the pinned wrangler (read-only captures) ──

const FIXTURES = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'wrangler-email',
  WRANGLER_EMAIL_PROSE_VERSION,
);

function fixture(name: string): EmailWranglerRunResult {
  return {
    status: Number(readFileSync(join(FIXTURES, `${name}.exit`), 'utf-8').trim()),
    stdout: readFileSync(join(FIXTURES, `${name}.stdout`), 'utf-8'),
    stderr: readFileSync(join(FIXTURES, `${name}.stderr`), 'utf-8'),
  };
}

/** The wrangler-sourced prose shapes the fixtures cannot show (rules present, catch-all to a worker). */
const RULES_WITH_ENTRIES = `
 ⛅️ wrangler 4.131.0
────────────────────
Rule: 1a2b3c
  Name:     support
  Enabled:  true
  Matchers: to:support@acme.com
  Actions:  worker:acme-support
  Priority: 0

Rule: 4d5e6f
  Name:     (none)
  Enabled:  true
  Matchers: to:sales@acme.com
  Actions:  forward:sales@gmail.com
  Priority: 1


Catch-all rule: enabled, action: worker:acme-support
  (use \`wrangler email routing rules get catch-all\` to view details)
`;

const BETA_WARNING =
  '\u001b[33m▲ \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m \u001b[1m🚧 `wrangler email x` is an open beta command.\u001b[0m\n';

function routingSettings(
  name: string,
  enabled: boolean,
  status: string,
  tag: string,
): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: `\n ⛅️ wrangler 4.131.0\n────────────────────\nEmail Routing for ${name}:\n  Enabled:  ${enabled}\n  Status:   ${status}\n  Created:  2026-03-18T02:37:48.990322Z\n  Modified: 2026-03-18T02:44:54.833251Z\n  Tag:      ${tag}\n`,
    stderr: BETA_WARNING,
  };
}

function zoneNotFound(name: string): EmailWranglerRunResult {
  return {
    status: 1,
    stdout: '\n ⛅️ wrangler 4.131.0\n────────────────────\n\n',
    stderr: `${BETA_WARNING}\n\n\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mCould not find zone for \`${name}\`. Make sure the domain exists in your account.\u001b[0m\n`,
  };
}

function sendingNotFound(name: string): EmailWranglerRunResult {
  return {
    status: 1,
    stdout: '\n ⛅️ wrangler 4.131.0\n────────────────────\n\n',
    stderr: `${BETA_WARNING}\n\n\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mNo sending subdomain found for \`${name}\`. Run \`wrangler email sending list ${name}\` to see configured subdomains.\u001b[0m\n`,
  };
}

function apiFailure(code: number, resource: string): EmailWranglerRunResult {
  return {
    status: 1,
    stdout: '',
    stderr: `${BETA_WARNING}\n\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mA request to the Cloudflare API (${resource}) failed.\u001b[0m\n\n  something went wrong [code: ${code}]\n`,
  };
}

// ── Scan builders ────────────────────────────────────────────────────────────────

function scan(files: Array<string>, defaultHandler?: string): EmailHandlersScan {
  return {
    addresses: files.map((filePath) => {
      const basename = filePath.replace(/\.[^.]+$/, '');
      return { address: basename.toLowerCase(), filePath, pattern: compileEmailPattern(basename)! };
    }),
    defaultHandler,
  };
}

// ── Fake seams ───────────────────────────────────────────────────────────────────

const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
const ACCOUNT = 'f721b8e5f721b8e5f721b8e5f721b8e5';
const BEARER = 'cfoa-SECRET-BEARER-TOKEN-0123456789';

type Call = { args: Array<string>; capture: boolean };
type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function fakeDns(overrides: {
  mx?: Record<string, Array<string>>;
  txt?: Record<string, Array<string>>;
  mxError?: Record<string, string>;
}): EmailDns {
  const noData = (): Error => Object.assign(new Error('queryMx ENODATA'), { code: 'ENODATA' });
  return {
    resolveMx: async (name) => {
      if (overrides.mxError?.[name]) {
        throw Object.assign(new Error(overrides.mxError[name]), { code: overrides.mxError[name] });
      }
      const list = overrides.mx?.[name];
      if (!list || list.length === 0) {
        throw noData();
      }
      return list.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    resolveTxt: async (name) => {
      const list = overrides.txt?.[name];
      if (!list || list.length === 0) {
        throw noData();
      }
      return list.map((v) => [v]);
    },
  };
}

function fakeRunner(
  table: Record<string, EmailWranglerRunResult | (() => EmailWranglerRunResult)>,
  calls: Array<Call>,
): EmailCloudflareInputs['runWrangler'] {
  return (args, opts) => {
    calls.push({ args: [...args], capture: opts.capture });
    const key = args.join(' ');
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected wrangler call: ${key}`);
    }
    return typeof hit === 'function' ? hit() : hit;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(
  table: Record<string, (call: FetchCall) => Response | Promise<Response>>,
  calls: Array<FetchCall>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    // Key on the API path after the base (`/client/v4`), so the table reads like the docs.
    const key = `${call.method} ${url.slice(url.indexOf('/zones'))}`;
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return hit(call);
  }) as typeof fetch;
}

function zonesOk(name: string, extra: Partial<{ type: string; account: string }> = {}) {
  return () =>
    jsonResponse(200, {
      success: true,
      result: [
        {
          id: ZONE_ID,
          name,
          type: extra.type ?? 'full',
          account: { id: extra.account ?? ACCOUNT },
        },
      ],
    });
}

function routingGet(supportSubaddress: boolean) {
  return () =>
    jsonResponse(200, {
      success: true,
      result: { enabled: true, support_subaddress: supportSubaddress },
    });
}

/**
 * The 0078 transcript scenario: `email/support+[ticket].ts` + `email/_default.ts`,
 * `email.from = noreply@mail.acme.com`, zone `acme.com` (routing ready on the apex,
 * Google MX there), nothing yet on `mail.acme.com`.
 */
function transcriptInputs(
  overrides: Partial<EmailCloudflareInputs> & {
    runnerTable?: Record<string, EmailWranglerRunResult | (() => EmailWranglerRunResult)>;
    fetchTable?: Record<string, (call: FetchCall) => Response | Promise<Response>>;
    calls?: Array<Call>;
    fetchCalls?: Array<FetchCall>;
    dns?: EmailDns;
  } = {},
): { inputs: EmailCloudflareInputs; calls: Array<Call>; fetchCalls: Array<FetchCall> } {
  const calls = overrides.calls ?? [];
  const fetchCalls = overrides.fetchCalls ?? [];
  const whoami = fixture('whoami');
  const runnerTable = {
    'whoami --json': whoami,
    'email routing settings mail.acme.com': zoneNotFound('mail.acme.com'),
    'email routing settings acme.com': routingSettings('acme.com', true, 'ready', ZONE_ID),
    'email routing rules list acme.com': fixture('routing-rules-list-void.cloud'),
    'email sending settings mail.acme.com': sendingNotFound('mail.acme.com'),
    ...overrides.runnerTable,
  };
  const fetchTable = {
    'GET /zones?name=acme.com': zonesOk('acme.com'),
    [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(false),
    ...overrides.fetchTable,
  };
  const rest: Partial<EmailCloudflareInputs> = { ...overrides };
  delete (rest as Record<string, unknown>).runnerTable;
  delete (rest as Record<string, unknown>).fetchTable;
  delete (rest as Record<string, unknown>).calls;
  delete (rest as Record<string, unknown>).fetchCalls;
  const inputs: EmailCloudflareInputs = {
    handlers: scan(['support+[ticket].ts'], '_default.ts'),
    from: 'noreply@mail.acme.com',
    workerName: 'acme-support',
    accountId: ACCOUNT,
    sendEmailFiles: 2,
    runWrangler: fakeRunner(runnerTable, calls),
    getSessionBearer: async () => BEARER,
    fetchImpl: fakeFetch(fetchTable, fetchCalls),
    dns: fakeDns({ mx: { 'acme.com': ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] } }),
    ...rest,
  };
  return { inputs, calls, fetchCalls };
}

// ── Derivation ───────────────────────────────────────────────────────────────────

describe('deriveAddresses', () => {
  it('maps literal and literal+[tag] handlers to <literal>@<domain>', () => {
    const out = deriveAddresses(
      scan(['support+[ticket].ts', 'sales.ts', 'Support.ts']),
      'mail.acme.com',
      'subdomain',
    );
    expect(out.addresses).toEqual(['support@mail.acme.com', 'sales@mail.acme.com']);
    expect(out.refused).toEqual([]);
    expect(out.routes).toEqual([
      { address: 'support@mail.acme.com', handler: 'email/support+[ticket].ts' },
      { address: 'sales@mail.acme.com', handler: 'email/sales.ts' },
      { address: 'support@mail.acme.com', handler: 'email/Support.ts' },
    ]);
  });

  it('_default.ts becomes *@<apex> on the apex only', () => {
    const apex = deriveAddresses(scan(['support.ts'], '_default.ts'), 'acme.com', 'apex');
    expect(apex.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(apex.refused).toEqual([]);

    const sub = deriveAddresses(scan(['support.ts'], '_default.ts'), 'mail.acme.com', 'subdomain');
    expect(sub.addresses).toEqual(['support@mail.acme.com']);
    expect(sub.refused).toEqual([
      {
        handler: 'email/_default.ts',
        reason: 'a catch-all exists only on an apex; other @mail.acme.com mail bounces',
      },
    ]);
  });

  it('[name].ts and [name]+[tag].ts need the catch-all: allowed on the apex, refused on a subdomain', () => {
    const apex = deriveAddresses(scan(['[name].ts', '[user]+[tag].ts']), 'acme.com', 'apex');
    expect(apex.addresses).toEqual(['*@acme.com']);
    expect(apex.refused).toEqual([]);

    const sub = deriveAddresses(
      scan(['[name].ts', '[user]+[tag].ts']),
      'mail.acme.com',
      'subdomain',
    );
    expect(sub.addresses).toEqual([]);
    expect(sub.refused.map((r) => r.handler)).toEqual(['email/[name].ts', 'email/[user]+[tag].ts']);
    for (const r of sub.refused) {
      expect(r.reason).toContain('catch-all');
      expect(r.reason).toContain('mail.acme.com');
    }
  });

  it('emits the catch-all once even when several handlers need it', () => {
    const out = deriveAddresses(scan(['[name].ts'], '_default.ts'), 'acme.com', 'apex');
    expect(out.addresses).toEqual(['*@acme.com']);
    expect(out.routes).toEqual([
      { address: '*@acme.com', handler: 'email/[name].ts' },
      { address: '*@acme.com', handler: 'email/_default.ts' },
    ]);
  });
});

describe('emailFromDomain', () => {
  it('extracts and lowercases the host', () => {
    expect(emailFromDomain('NoReply@Mail.Acme.com')).toBe('mail.acme.com');
    expect(emailFromDomain('bad')).toBeNull();
    expect(emailFromDomain('@acme.com')).toBeNull();
    expect(emailFromDomain('a@')).toBeNull();
    expect(emailFromDomain('a@localhost')).toBeNull();
  });

  it('reads the address inside a display-name form (the shape void.json accepts)', () => {
    expect(emailFromDomain('Acme Support <NoReply@Mail.Acme.com>')).toBe('mail.acme.com');
    expect(emailFromDomain('"Acme, Inc" <noreply@acme.com> ')).toBe('acme.com');
    expect(emailFromDomain('Acme <bad>')).toBeNull();
    expect(emailFromDomain('Acme <>')).toBeNull();
  });
});

// ── Prose parsers pinned to the shipped wrangler ─────────────────────────────────

describe(`wrangler ${WRANGLER_EMAIL_PROSE_VERSION} prose parsers (fixtures)`, () => {
  it('routing settings: ready zone', () => {
    const f = fixture('routing-settings-void.cloud');
    expect(f.status).toBe(0);
    expect(parseRoutingSettings(f.stdout)).toEqual({
      name: 'void.cloud',
      enabled: true,
      status: 'ready',
      tag: '5b66f5cb84fd7dcfdd0170515e622181',
    });
  });

  it('routing settings: unconfigured zone', () => {
    const f = fixture('routing-settings-void.app');
    expect(parseRoutingSettings(f.stdout)).toEqual({
      name: 'void.app',
      enabled: false,
      status: 'unconfigured',
      tag: '198763c1ff7c51a4c97e5f6e6ee1d2f4',
    });
  });

  it('routing settings: a subdomain is not a zone (exit 1, message on stderr, stdout empty)', () => {
    const f = fixture('routing-settings-mail.void.cloud');
    expect(f.status).toBe(1);
    expect(parseRoutingSettings(f.stdout)).toBeNull();
    expect(f.stderr).toContain('Could not find zone for `mail.void.cloud`');
  });

  it('rules list: no custom rules, catch-all disabled', () => {
    const f = fixture('routing-rules-list-void.cloud');
    expect(parseRoutingRules(f.stdout)).toEqual({
      rules: [],
      catchAll: { enabled: false, actions: ['drop'] },
    });
  });

  it('rules list: rules and an enabled catch-all (shape from wrangler src/email-routing/rules/list.ts)', () => {
    expect(parseRoutingRules(RULES_WITH_ENTRIES)).toEqual({
      rules: [
        {
          id: '1a2b3c',
          name: 'support',
          enabled: true,
          to: ['support@acme.com'],
          actions: ['worker:acme-support'],
        },
        {
          id: '4d5e6f',
          name: '(none)',
          enabled: true,
          to: ['sales@acme.com'],
          actions: ['forward:sales@gmail.com'],
        },
      ],
      catchAll: { enabled: true, actions: ['worker:acme-support'] },
    });
    expect(
      parseRoutingRules('\n ⛅️ wrangler 4.131.0\n────────────────────\nNo routing rules found.\n'),
    ).toEqual({
      rules: [],
      catchAll: null,
    });
  });

  it('sending settings: onboarded domain, and the not-found variant', () => {
    expect(parseSendingSettings(fixture('sending-settings-void.cloud').stdout)).toEqual({
      name: 'void.cloud',
      enabled: true,
      tag: '19af4fdbee924a92916afea0de5a8fdd',
    });
    const missing = fixture('sending-settings-nonexistent.void.cloud');
    expect(missing.status).toBe(1);
    expect(parseSendingSettings(missing.stdout)).toBeNull();
    expect(missing.stderr).toContain('No sending subdomain found for `nonexistent.void.cloud`');
  });

  it('whoami --json: scopes and accounts', () => {
    const who = parseWhoamiJson(fixture('whoami').stdout)!;
    expect(who.loggedIn).toBe(true);
    expect(who.tokenPermissions).toContain('email_routing:write');
    expect(who.tokenPermissions).toContain('email_sending:write');
    expect(who.accounts?.map((a) => a.id)).toContain(ACCOUNT);
  });

  it('every parser fails closed on prose it does not recognise', () => {
    expect(parseRoutingSettings('Email Routing for x:\n  Enabled: maybe\n')).toBeNull();
    expect(parseRoutingRules('Rules:\n  - stuff\n')).toBeNull();
    expect(parseSendingSettings('Email Sending enabled for x (enabled: true)')).toBeNull();
    expect(parseWhoamiJson('not json')).toBeNull();
  });

  it('extracts wrangler API error codes through ANSI', () => {
    expect(wranglerApiErrorCode(apiFailure(2040, '/zones/x/email/sending/subdomains').stderr)).toBe(
      2040,
    );
    expect(wranglerApiErrorCode('plain failure')).toBeNull();
  });
});

// ── Preflight ────────────────────────────────────────────────────────────────────

describe('preflightEmail', () => {
  it('first deploy on a subdomain: every row pending, no blocker, exact read-only argv', async () => {
    const { inputs, calls, fetchCalls } = transcriptInputs();
    const pre = await preflightEmail(inputs);

    expect(pre.mode).toBe('subdomain');
    expect(pre.apex).toBe('acme.com');
    expect(pre.zone).toEqual({ state: 'found', zoneId: ZONE_ID, type: 'full' });
    expect(pre.session).toMatchObject({
      state: 'ok',
      email: 'dev@example.com',
      accountName: 'Acme',
    });
    expect(pre.apexMx).toEqual({
      state: 'foreign',
      exchanges: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'],
    });
    expect(pre.domainMx).toEqual({ state: 'empty', exchanges: [] });
    expect(pre.routing.state).toBe('pending');
    expect(pre.subaddressing.state).toBe('off');
    expect(pre.sending).toEqual({ state: 'pending', dnsConflicts: [] });
    expect(pre.rules).toEqual({
      state: 'pending',
      mine: [],
      foreign: [],
      absent: ['support@mail.acme.com'],
    });
    expect(pre.binding).toEqual({ state: 'absent' });
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
    expect(pre.derived.refused).toHaveLength(1);
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(false);

    expect(calls.map((c) => c.args)).toEqual([
      ['whoami', '--json'],
      ['email', 'routing', 'settings', 'mail.acme.com'],
      ['email', 'routing', 'settings', 'acme.com'],
      ['email', 'routing', 'rules', 'list', 'acme.com'],
      ['email', 'sending', 'settings', 'mail.acme.com'],
    ]);
    expect(calls.every((c) => c.capture)).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      'GET /zones?name=acme.com',
      `GET /zones/${ZONE_ID}/email/routing`,
    ]);
  });

  it('appends the deploy runner args (`-c <cfg> --env=`) to every wrangler call', async () => {
    const suffix = ['-c', 'wrangler.jsonc', '--env='];
    const base = transcriptInputs();
    const seen: Array<Array<string>> = [];
    const { inputs } = transcriptInputs({
      wranglerArgs: suffix,
      // The base table keys on the bare argv; strip the suffix before delegating.
      runWrangler: (args, opts) => {
        seen.push([...args]);
        return base.inputs.runWrangler(args.slice(0, -suffix.length), opts);
      },
    });
    await preflightEmail(inputs);
    expect(seen).toHaveLength(5);
    for (const args of seen) {
      expect(args.slice(-suffix.length)).toEqual(suffix);
    }
  });

  it('second deploy, everything set up: ready, zero changes', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES.replace('to:support@acme.com', 'to:support@mail.acme.com'),
          stderr: BETA_WARNING,
        },
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                19af4fdbee924a92916afea0de5a8fdd\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
      dns: fakeDns({
        mx: {
          'acme.com': ['aspmx.l.google.com'],
          'mail.acme.com': ['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'],
        },
      }),
      handlers: scan(['support+[ticket].ts']),
      existingSendEmail: [{ name: 'SEND_EMAIL' }],
      existingAddresses: ['support@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.routing.state).toBe('ready');
    expect(pre.subaddressing.state).toBe('on');
    expect(pre.sending.state).toBe('ready');
    expect(pre.rules).toEqual({
      state: 'ready',
      mine: ['support@mail.acme.com'],
      foreign: [],
      absent: [],
    });
    expect(pre.binding.state).toBe('present');
    expect(pre.addressesOwnership).toEqual({ state: 'mine', foreign: [] });
    expect(pre.blockers).toEqual([]);
    expect(pre.ready).toBe(true);
    expect(renderEmailChecklist(pre)).toContain('Nothing to change — email is set up.');
  });

  it('refuses the apex when foreign MX already receives mail there', async () => {
    const { inputs } = transcriptInputs({
      from: 'noreply@acme.com',
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.mode).toBe('apex');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'acme.com already receives mail (aspmx.l.google.com, alt1.aspmx.l.google.com). Void never enables routing over live mail. Use something@mail.acme.com.',
      },
    ]);
    expect(pre.ready).toBe(false);
  });

  it('allows the apex with an empty MX (decision 10), catch-all included', async () => {
    const { inputs } = transcriptInputs({
      from: 'noreply@acme.com',
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
      dns: fakeDns({}),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.blockers).toEqual([]);
    expect(pre.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(pre.derived.refused).toEqual([]);
    expect(pre.rules.absent).toEqual(['support@acme.com', '*@acme.com']);
  });

  it('blocks on a session without the email scopes (`wrangler login`)', async () => {
    const who = JSON.parse(fixture('whoami').stdout) as { tokenPermissions: Array<string> };
    who.tokenPermissions = who.tokenPermissions.filter((s) => !s.startsWith('email_'));
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      runnerTable: { 'whoami --json': { status: 0, stdout: JSON.stringify(who), stderr: '' } },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.session.state).toBe('missing-scopes');
    expect(pre.session.missingScopes).toEqual(['email_routing:write', 'email_sending:write']);
    expect(pre.blockers[0]?.message).toContain('wrangler login');
    // No other read runs on a session that cannot do the work.
    expect(calls.map((c) => c.args.join(' '))).toEqual(['whoami --json']);
  });

  it('blocks when not logged in', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'whoami --json': { status: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.session.state).toBe('not-logged-in');
    expect(pre.blockers.map((b) => b.scope)).toEqual(['all']);
  });

  it('blocks on routing status unlocked / misconfigured — never re-locks', async () => {
    for (const status of ['unlocked', 'misconfigured', 'misconfigured_locked']) {
      const { inputs } = transcriptInputs({
        runnerTable: {
          'email routing settings acme.com': routingSettings('acme.com', true, status, ZONE_ID),
        },
      });
      const pre = await preflightEmail(inputs);
      expect(
        pre.blockers.some(
          (b) => b.message.includes(status) && b.message.includes('never re-locks'),
        ),
      ).toBe(true);
    }
  });

  it('refuses sending onboarding when _dmarc / cf-bounce TXT already exist (sending-scoped)', async () => {
    const { inputs } = transcriptInputs({
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        txt: {
          '_dmarc.mail.acme.com': ['v=DMARC1; p=none'],
          'cf-bounce.mail.acme.com': ['v=spf1'],
        },
      }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.sending.dnsConflicts).toEqual(['_dmarc.mail.acme.com', 'cf-bounce.mail.acme.com']);
    expect(pre.blockers).toEqual([
      {
        scope: 'sending',
        message: expect.stringContaining(
          '_dmarc.mail.acme.com, cf-bounce.mail.acme.com already exists',
        ),
      },
    ]);
    // Routing is still on the table — the sending blocker is not an `all` blocker.
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
  });

  it('prunes an address already routed elsewhere and reports the owner (decision 12)', async () => {
    const { inputs } = transcriptInputs({
      handlers: scan(['support.ts', 'sales.ts']),
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES.replace(
            'to:support@acme.com',
            'to:support@mail.acme.com',
          ).replace('to:sales@acme.com', 'to:sales@mail.acme.com'),
          stderr: BETA_WARNING,
        },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.rules.mine).toEqual(['support@mail.acme.com']);
    expect(pre.rules.foreign).toEqual([
      { address: 'sales@mail.acme.com', owner: 'forward:sales@gmail.com' },
    ]);
    expect(pre.addresses).toEqual(['support@mail.acme.com']);
    expect(pre.blockers).toEqual([]);
    expect(renderEmailChecklist(pre)).toContain(
      `    ! ${'sales@mail.acme.com'.padEnd(44)}already routed to forward:sales@gmail.com; left alone, not in addresses`,
    );
  });

  it('treats a catch-all owned by another worker as foreign, by this worker as mine', async () => {
    const base = {
      from: 'noreply@acme.com',
      runnerTable: {
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
      dns: fakeDns({ mx: { 'acme.com': ['route1.mx.cloudflare.net'] } }),
      handlers: scan([], '_default.ts'),
    };
    const foreign = transcriptInputs({
      ...base,
      runnerTable: {
        ...base.runnerTable,
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES.replace(
            'worker:acme-support\n  (use',
            'worker:other-worker\n  (use',
          ),
          stderr: BETA_WARNING,
        },
      },
    });
    const preForeign = await preflightEmail(foreign.inputs);
    expect(preForeign.rules.foreign).toEqual([
      { address: '*@acme.com', owner: 'worker:other-worker' },
    ]);
    expect(preForeign.addresses).toEqual([]);

    const mine = transcriptInputs({
      ...base,
      runnerTable: {
        ...base.runnerTable,
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES,
          stderr: BETA_WARNING,
        },
      },
    });
    const preMine = await preflightEmail(mine.inputs);
    expect(preMine.rules.mine).toEqual(['*@acme.com']);
  });

  it('refuses a hand-written `addresses` array holding entries Void did not derive (decision 13)', async () => {
    const { inputs } = transcriptInputs({
      existingAddresses: ['support@mail.acme.com', 'billing@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.addressesOwnership).toEqual({
      state: 'foreign',
      foreign: ['billing@mail.acme.com'],
    });
    expect(pre.blockers).toEqual([
      { scope: 'all', message: expect.stringContaining('billing@mail.acme.com') },
    ]);
    expect(pre.blockers[0]?.message).toContain('skipping email setup this deploy');
  });

  it('refuses an existing send_email binding not named SEND_EMAIL, with the rename', async () => {
    const { inputs } = transcriptInputs({ existingSendEmail: [{ name: 'EMAIL' }] });
    const pre = await preflightEmail(inputs);
    expect(pre.binding).toEqual({ state: 'foreign', foreignName: 'EMAIL' });
    expect(pre.blockers[0]?.message).toBe(
      'wrangler.jsonc already has a send_email binding named "EMAIL"; rename it to SEND_EMAIL (a second binding would be silent)',
    );
  });

  it('zone not on Cloudflare in this account: blocker, no rules/sending reads', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      runnerTable: { 'email routing settings acme.com': zoneNotFound('acme.com') },
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        'GET /zones?name=acme.com': () => jsonResponse(200, { success: true, result: [] }),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone.state).toBe('not-found');
    expect(pre.blockers).toEqual([
      { scope: 'all', message: expect.stringContaining('no zone for mail.acme.com') },
    ]);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'whoami --json',
      'email routing settings mail.acme.com',
      'email routing settings acme.com',
    ]);
  });

  it('zone in another account is told apart from not-on-Cloudflare via GET /zones?name= without account.id', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      fetchCalls,
      runnerTable: { 'email routing settings acme.com': zoneNotFound('acme.com') },
      fetchTable: {
        'GET /zones?name=mail.acme.com': () => jsonResponse(200, { success: true, result: [] }),
        'GET /zones?name=acme.com': zonesOk('acme.com', {
          account: '00000000000000000000000000000000',
        }),
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone.state).toBe('other-account');
    expect(pre.blockers[0]?.message).toContain('different Cloudflare account');
    for (const call of fetchCalls) {
      expect(call.url).not.toContain('account.id');
    }
  });

  it('refuses a partial (CNAME-setup) zone', async () => {
    const { inputs } = transcriptInputs({
      fetchTable: { 'GET /zones?name=acme.com': zonesOk('acme.com', { type: 'partial' }) },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.zone).toEqual({ state: 'partial', zoneId: ZONE_ID, type: 'partial' });
    expect(pre.blockers[0]?.message).toContain('partial zone');
  });

  it('a parser miss fails closed: unknown row + `run void email setup`', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: 'Rules:\n  totally new prose\n',
          stderr: '',
        },
      },
    });
    const pre = await preflightEmail(inputs);
    expect(pre.rules.state).toBe('unknown');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'could not read Email Routing rules — unknown — run `void email setup --backend cloudflare`',
      },
    ]);
  });

  it('works without a bearer: subaddressing unknown, zone from the settings Tag, no fetch', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({ fetchCalls, getSessionBearer: async () => null });
    const pre = await preflightEmail(inputs);
    expect(fetchCalls).toEqual([]);
    expect(pre.zone).toEqual({ state: 'found', zoneId: ZONE_ID });
    expect(pre.subaddressing.state).toBe('unknown');
    expect(pre.blockers).toEqual([]);
  });

  it('a refused handler or a DMARC conflict does not keep a set-up deploy from reading ready', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES.replace('to:support@acme.com', 'to:support@mail.acme.com'),
          stderr: BETA_WARNING,
        },
      },
      fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
        txt: { '_dmarc.mail.acme.com': ['v=DMARC1; p=none'] },
      }),
      // `_default.ts` stays refused on the subdomain; sending stays blocked by the TXT.
      existingSendEmail: [{ name: 'SEND_EMAIL' }],
      existingAddresses: ['support@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.derived.refused).toHaveLength(1);
    expect(pre.blockers.map((b) => b.scope)).toEqual(['sending']);
    expect(pre.ready).toBe(true);
  });

  it('an MX lookup that fails outright is unknown, and blocks (fail closed)', async () => {
    const { inputs } = transcriptInputs({
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        mxError: { 'mail.acme.com': 'ETIMEOUT' },
      }),
    });
    const pre = await preflightEmail(inputs);
    expect(pre.domainMx.state).toBe('unknown');
    expect(pre.blockers).toEqual([
      {
        scope: 'all',
        message:
          'could not read the MX records of mail.acme.com — unknown — run `void email setup --backend cloudflare`',
      },
    ]);
  });

  it('rejects an email.from that is not an address', async () => {
    const { inputs } = transcriptInputs({ from: 'nope' });
    await expect(preflightEmail(inputs)).rejects.toThrow('email.from must be an address');
  });
});

// ── Checklist ────────────────────────────────────────────────────────────────────

describe('renderEmailChecklist', () => {
  it('renders the 0078 transcript block for the first subdomain deploy', async () => {
    const who = JSON.parse(fixture('whoami').stdout) as {
      email: string;
      accounts: Array<{ id: string; name: string }>;
    };
    who.email = 'dev@acme.com';
    who.accounts = [{ id: ACCOUNT, name: 'Acme' }];
    const { inputs } = transcriptInputs({
      runnerTable: { 'whoami --json': { status: 0, stdout: JSON.stringify(who), stderr: '' } },
    });
    const pre = await preflightEmail(inputs);
    expect(renderEmailChecklist(pre)).toBe(
      [
        '  Email in use   email/support+[ticket].ts · email/_default.ts · sendEmail() in 2 files',
        '    domain    mail.acme.com          (void.json email.from)',
        '    zone      acme.com               account Acme (f721b8e5…) · session dev@acme.com',
        '    apex MX   aspmx.l.google.com     left alone — mail lives on the subdomain',
        '    routing   mail.acme.com  not enabled · subaddressing off',
        '    sending   mail.acme.com  not onboarded',
        '    rules     support@mail.acme.com → acme-support   (absent)',
        '    binding   SEND_EMAIL             (absent)',
        '',
        '  This changes YOUR Cloudflare account. acme.com itself is not touched.',
        '    + enable Email Routing on mail.acme.com       Cloudflare writes and locks 3 MX + 1 SPF record there',
        '    + turn on subaddressing for acme.com          support+anything@ reaches support@',
        '    + onboard mail.acme.com for Email Sending     MX/SPF/DKIM on cf-bounce.mail.acme.com, _dmarc.mail.acme.com (p=reject)',
        '    + wrangler.jsonc                              send_email: [{ name: "SEND_EMAIL" }], addresses: ["support@mail.acme.com"]',
        '    + routing rule (applied by wrangler deploy)   support@mail.acme.com → acme-support',
        '    ! email/_default.ts                           a catch-all exists only on an apex; other @mail.acme.com mail bounces',
      ].join('\n'),
    );
  });

  it('renders blockers as ✘ rows so the developer sees why nothing is asked', async () => {
    const { inputs } = transcriptInputs({ existingSendEmail: [{ name: 'EMAIL' }] });
    const pre = await preflightEmail(inputs);
    const text = renderEmailChecklist(pre);
    expect(text).toContain('    binding   SEND_EMAIL             (found EMAIL instead)');
    expect(text).toContain('    ✘ wrangler.jsonc already has a send_email binding named "EMAIL"');
  });
});

// ── Apply ────────────────────────────────────────────────────────────────────────

const ROUTING_DNS_POST = `POST /zones/${ZONE_ID}/email/routing/dns`;
const ROUTING_PATCH = `PATCH /zones/${ZONE_ID}/email/routing`;

function sendingEnabled(name: string): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: `Email Sending enabled for ${name} (enabled: true)\n`,
    stderr: BETA_WARNING,
  };
}

describe('applyEmailSetup', () => {
  it('happy subdomain path: exact argv + exact REST calls, bearer in Authorization and nowhere else', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [ROUTING_PATCH]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;

    const out = await applyEmailSetup(pre, inputs);
    expect(out.routingReady).toBe(true);
    expect(out.subaddressingReady).toBe(true);
    expect(out.sendingReady).toBe(true);
    expect(out.addressesWithheld).toBe(false);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });
    expect(out.lines).toEqual([
      '  ✔ routing   mail.acme.com enabled',
      '  ✔ routing   subaddressing on for acme.com',
      '  ✔ sending   mail.acme.com onboarded',
      '  ✔ config    wrangler.jsonc updated',
    ]);

    expect(calls.map((c) => c.args)).toEqual([['email', 'sending', 'enable', 'mail.acme.com']]);
    expect(fetchCalls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/dns`,
        method: 'POST',
        headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'mail.acme.com' }),
      },
      {
        url: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing`,
        method: 'PATCH',
        headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ support_subaddress: true }),
      },
    ]);
    for (const call of fetchCalls) {
      expect(call.url).not.toContain(BEARER);
      expect(call.body).not.toContain(BEARER);
    }
  });

  it('apex path: `wrangler email routing enable <apex>`, then the subaddressing PATCH through the bearer', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      from: 'noreply@acme.com',
      dns: fakeDns({}),
      runnerTable: {
        'email routing settings acme.com': routingSettings(
          'acme.com',
          false,
          'unconfigured',
          ZONE_ID,
        ),
        'email sending settings acme.com': sendingNotFound('acme.com'),
        'email routing enable acme.com': {
          status: 0,
          stdout: 'Email Routing enabled for acme.com (status: ready)\n',
          stderr: BETA_WARNING,
        },
        'email sending enable acme.com': sendingEnabled('acme.com'),
      },
      fetchTable: {
        [ROUTING_PATCH]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls.map((c) => c.args)).toEqual([
      ['email', 'routing', 'enable', 'acme.com'],
      ['email', 'sending', 'enable', 'acme.com'],
    ]);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      ROUTING_PATCH,
    ]);
    expect(out.patch.addresses).toEqual(['support@acme.com', '*@acme.com']);
    expect(out.lines[0]).toBe('  ✔ routing   acme.com enabled');
  });

  it('bearer failure → dashboard fallback line, addresses withheld (deleted), deploy continues', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      getSessionBearer: async () => null,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(out.routingReady).toBe(false);
    expect(out.addressesWithheld).toBe(true);
    expect(out.patch.addresses).toBeNull();
    // Sending still onboarded → the binding is still written.
    expect(out.sendingReady).toBe(true);
    expect(out.patch.sendEmail).toEqual({ name: 'SEND_EMAIL' });
    expect(out.lines).toContain(`    ${SUBDOMAIN_DASHBOARD_FALLBACK}`);
    expect(out.lines.some((l) => l.includes('addresses withheld this run'))).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['email', 'sending', 'enable', 'mail.acme.com']]);
  });

  it('non-2xx on the subdomain POST → fallback line + withheld; the PATCH is not attempted', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      fetchCalls,
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [ROUTING_DNS_POST]: () =>
          jsonResponse(400, {
            success: false,
            errors: [{ code: 2062, message: 'routing not enabled' }],
          }),
      },
    });
    const pre = await preflightEmail(inputs);
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(fetchCalls.map((c) => c.method)).toEqual(['POST']);
    expect(out.addressesWithheld).toBe(true);
    expect(out.patch.addresses).toBeNull();
    expect(out.lines[0]).toBe(
      '  ✘ routing   mail.acme.com: Cloudflare answered 400 [code: 2062] — Email Routing is not enabled on this zone',
    );
    expect(out.lines[1]).toBe(`    ${SUBDOMAIN_DASHBOARD_FALLBACK}`);
  });

  it('`[code: 2040]` on sending enable means already onboarded → ok', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email sending enable mail.acme.com': apiFailure(
          2040,
          `/zones/${ZONE_ID}/email/sending/subdomains`,
        ),
      },
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    const out = await applyEmailSetup(pre, inputs);
    expect(out.sendingReady).toBe(true);
    expect(out.lines).toContain('  ✔ sending   mail.acme.com onboarded');
    expect(out.patch.sendEmail).toEqual({ name: 'SEND_EMAIL' });
  });

  it('sending enable fails on Workers Free (10105) → hint line, continue with inbound', async () => {
    const { inputs } = transcriptInputs({
      runnerTable: {
        'email sending enable mail.acme.com': apiFailure(
          10105,
          `/zones/${ZONE_ID}/email/sending/subdomains`,
        ),
      },
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    const out = await applyEmailSetup(pre, inputs);
    expect(out.sendingReady).toBe(false);
    expect(out.routingReady).toBe(true);
    expect(out.lines).toContain(
      '  ! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(out.lines).toContain(`    ${SENDING_FREE_PLAN_HINT}`);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });
  });

  it('a sending-scoped blocker (DMARC present) skips sending enable, routing still applies', async () => {
    const calls: Array<Call> = [];
    const { inputs } = transcriptInputs({
      calls,
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'] },
        txt: { '_dmarc.mail.acme.com': ['v=DMARC1'] },
      }),
      fetchTable: {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: () => jsonResponse(200, { success: true, result: {} }),
      },
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(out.sendingReady).toBe(false);
    expect(out.routingReady).toBe(true);
    expect(
      out.lines.some((l) => l.startsWith('  ! sending   _dmarc.mail.acme.com already exists')),
    ).toBe(true);
  });

  it('re-run with everything ready → zero wrangler calls, zero fetches, same patch', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout: RULES_WITH_ENTRIES.replace('to:support@acme.com', 'to:support@mail.acme.com'),
          stderr: BETA_WARNING,
        },
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                19af4fdbee924a92916afea0de5a8fdd\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: { [`GET /zones/${ZONE_ID}/email/routing`]: routingGet(true) },
      dns: fakeDns({
        mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
      }),
      handlers: scan(['support+[ticket].ts']),
      existingSendEmail: [{ name: 'SEND_EMAIL' }],
      existingAddresses: ['support@mail.acme.com'],
    });
    const pre = await preflightEmail(inputs);
    expect(pre.ready).toBe(true);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(out.patch).toEqual({
      sendEmail: { name: 'SEND_EMAIL' },
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      addresses: ['support@mail.acme.com'],
    });
  });

  it('a blocked preflight applies nothing and returns an empty patch', async () => {
    const calls: Array<Call> = [];
    const fetchCalls: Array<FetchCall> = [];
    const { inputs } = transcriptInputs({
      calls,
      fetchCalls,
      existingSendEmail: [{ name: 'EMAIL' }],
    });
    const pre = await preflightEmail(inputs);
    calls.length = 0;
    fetchCalls.length = 0;
    const out = await applyEmailSetup(pre, inputs);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
    expect(out.patch).toEqual({});
    expect(out.lines[0]).toContain('✘ wrangler.jsonc already has a send_email binding');
  });

  it('never surfaces the bearer in a printed line, a thrown error, or the returned object', async () => {
    // Every transport outcome that could carry the token: a fetch that throws with it in
    // the message, a non-2xx whose error message echoes it, and a happy path.
    const leaky = (call: FetchCall): Response => {
      throw new Error(`boom ${call.headers.Authorization}`);
    };
    const echo = () =>
      jsonResponse(403, {
        success: false,
        errors: [{ code: 10000, message: `bad token Bearer ${BEARER}` }],
      });
    const tables: Array<Record<string, (call: FetchCall) => Response>> = [
      { [ROUTING_DNS_POST]: leaky },
      { [ROUTING_DNS_POST]: echo },
      {
        [ROUTING_DNS_POST]: () => jsonResponse(200, { success: true, result: {} }),
        [ROUTING_PATCH]: leaky,
      },
    ];
    for (const table of tables) {
      const { inputs } = transcriptInputs({
        runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
        fetchTable: table,
      });
      const pre = await preflightEmail(inputs);
      let out: unknown;
      let thrown: unknown;
      try {
        out = await applyEmailSetup(pre, inputs);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeUndefined();
      const serialised = JSON.stringify(out);
      // The fakes echo the header back on purpose; `fetchWithSessionBearer` scrubs it.
      for (const line of (out as { lines: Array<string> }).lines) {
        expect(line).not.toContain(BEARER);
      }
      expect(serialised).not.toContain(BEARER);
      expect(JSON.stringify(pre)).not.toContain(BEARER);
    }
  });
});

describe('fetchWithSessionBearer', () => {
  it('puts the token only in the Authorization header and never throws', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const f = fakeFetch({ 'GET /zones?name=acme.com': zonesOk('acme.com') }, fetchCalls);
    const ok = await fetchWithSessionBearer(f, BEARER, 'GET', '/zones?name=acme.com');
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(fetchCalls[0]?.headers).toEqual({ Authorization: `Bearer ${BEARER}` });
    expect(fetchCalls[0]?.body).toBeUndefined();

    const boom = await fetchWithSessionBearer(
      (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
      BEARER,
      'POST',
      '/zones/x/email/routing/dns',
      { name: 'x' },
    );
    expect(boom).toEqual({
      ok: false,
      status: 0,
      result: null,
      errors: [{ code: 0, message: 'ECONNRESET' }],
    });

    const html = await fetchWithSessionBearer(
      (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch,
      BEARER,
      'GET',
      '/zones',
    );
    expect(html).toEqual({ ok: false, status: 502, result: null, errors: [] });
  });

  it('honours a custom API base (the pinned transport)', async () => {
    const fetchCalls: Array<FetchCall> = [];
    const f = fakeFetch({ 'GET /zones?name=acme.com': zonesOk('acme.com') }, fetchCalls);
    await fetchWithSessionBearer(
      f,
      BEARER,
      'GET',
      '/zones?name=acme.com',
      undefined,
      'https://api.example.test/v4',
    );
    expect(fetchCalls[0]?.url).toBe('https://api.example.test/v4/zones?name=acme.com');
  });
});

// ── Address map ──────────────────────────────────────────────────────────────────

describe('renderAddressMap', () => {
  it('renders the post-deploy block', () => {
    expect(
      renderAddressMap({
        from: 'support@mail.acme.com',
        routes: [{ address: 'support@mail.acme.com', handler: 'email/support+[ticket].ts' }],
        addresses: ['support@mail.acme.com'],
        sendingReady: true,
      }),
    ).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from support@mail.acme.com',
      ].join('\n'),
    );
  });

  it('marks routes outside the written addresses and a sending that is not onboarded', () => {
    const text = renderAddressMap({
      from: 'noreply@acme.com',
      routes: [
        { address: 'support@acme.com', handler: 'email/support.ts' },
        { address: '*@acme.com', handler: 'email/_default.ts' },
      ],
      addresses: ['support@acme.com'],
      sendingReady: false,
    });
    expect(text).toBe(
      [
        '    inbound   support@acme.com  →  email/support.ts',
        '    inbound   *@acme.com        →  email/_default.ts   (no rule this deploy)',
        '    outbound  sendEmail() from noreply@acme.com   (verified destinations only)',
      ].join('\n'),
    );
  });

  it('takes a pending label that does not name a deploy (`void email status`)', () => {
    const text = renderAddressMap({
      from: 'noreply@acme.com',
      routes: [{ address: 'support@acme.com', handler: 'email/support.ts' }],
      addresses: [],
      sendingReady: true,
      pendingLabel: '(no rule yet)',
    });
    expect(text).toBe(
      [
        '    inbound   support@acme.com  →  email/support.ts   (no rule yet)',
        '    outbound  sendEmail() from noreply@acme.com',
      ].join('\n'),
    );
  });
});
