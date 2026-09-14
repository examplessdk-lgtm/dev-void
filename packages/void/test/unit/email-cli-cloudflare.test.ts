import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { log } from '@clack/prompts';
import { join } from 'pathslash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  SENDING_FREE_PLAN_HINT,
  WRANGLER_EMAIL_PROSE_VERSION,
  type EmailDns,
  type EmailWranglerRunResult,
} from '../../src/cli/email-cloudflare.ts';
import { runEmailCloudflareCommand, runEmailCommand } from '../../src/cli/email.ts';

/**
 * `void email setup|status --platform cloudflare` on the 0078 transcript project:
 * `email/support+[ticket].ts` + `email/_default.ts`, `email.from = noreply@mail.acme.com`,
 * zone `acme.com` (routing ready on the apex, Google MX there), nothing on `mail.acme.com`.
 * Every Cloudflare touch is a fake; the wrangler prose comes from the pinned fixtures.
 */

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

const ZONE_ID = '5b66f5cb84fd7dcfdd0170515e622181';
const ACCOUNT = 'f721b8e5f721b8e5f721b8e5f721b8e5';
const BEARER = 'cfoa-SECRET-BEARER-TOKEN-0123456789';
const BETA_WARNING = '▲ [WARNING] 🚧 `wrangler email x` is an open beta command.\n';

function routingSettings(name: string, status: string, enabled = true): EmailWranglerRunResult {
  return {
    status: 0,
    stdout: `Email Routing for ${name}:\n  Enabled:  ${enabled}\n  Status:   ${status}\n  Tag:      ${ZONE_ID}\n`,
    stderr: BETA_WARNING,
  };
}

function zoneNotFound(name: string): EmailWranglerRunResult {
  return {
    status: 1,
    stdout: '',
    stderr: `${BETA_WARNING}✘ [ERROR] Could not find zone for \`${name}\`. Make sure the domain exists in your account.\n`,
  };
}

function sendingNotFound(name: string): EmailWranglerRunResult {
  return {
    status: 1,
    stdout: '',
    stderr: `${BETA_WARNING}✘ [ERROR] No sending subdomain found for \`${name}\`.\n`,
  };
}

function sendingEnabled(name: string): EmailWranglerRunResult {
  return { status: 0, stdout: `Email Sending enabled for ${name} (enabled: true)\n`, stderr: '' };
}

type Call = { args: Array<string>; capture: boolean };
type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeRunner(table: Record<string, EmailWranglerRunResult>, calls: Array<Call>) {
  return (args: Array<string>, opts: { capture: boolean }): EmailWranglerRunResult => {
    calls.push({ args: [...args], capture: opts.capture });
    // The command appends `-c <configPath> --env=` to every call; key the table on the
    // command words and assert the suffix separately.
    const key = args.slice(0, args.indexOf('-c') < 0 ? args.length : args.indexOf('-c')).join(' ');
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected wrangler call: ${args.join(' ')}`);
    }
    return hit;
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(table: Record<string, () => Response>, calls: Array<FetchCall>): typeof fetch {
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
    const key = `${call.method} ${url.slice(url.indexOf('/zones'))}`;
    const hit = table[key];
    if (!hit) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    return hit();
  }) as typeof fetch;
}

function fakeDns(mx: Record<string, Array<string>>): EmailDns {
  const noData = (): Error => Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  return {
    resolveMx: async (name) => {
      const list = mx[name];
      if (!list) {
        throw noData();
      }
      return list.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
    },
    resolveTxt: async () => {
      throw noData();
    },
  };
}

/** Capture clack's `log.*` lines — the command's final verdict is one of those, not a `print` block. */
function captureLog(): { lines: Array<string>; restore: () => void } {
  const lines: Array<string> = [];
  const spies = (['message', 'info', 'warn', 'error', 'success', 'step'] as const).map((level) =>
    vi.spyOn(log, level).mockImplementation(((...args: Array<unknown>) => {
      lines.push(args.map(String).join(' '));
    }) as never),
  );
  return {
    lines,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Run the command; resolve the exit code (0 when it returned without exiting). */
async function run(
  root: string,
  subcommand: 'setup' | 'status',
  deps: Parameters<typeof runEmailCloudflareCommand>[2],
): Promise<number> {
  try {
    await runEmailCloudflareCommand(
      root,
      { subcommand, platform: 'cloudflare' },
      {
        ...deps,
        exit: (code: number): never => {
          throw new ExitSignal(code);
        },
      },
    );
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

const INITIAL_WRANGLER = `{
  // the pinned account
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "compatibility_date": "2026-01-01",
}
`;

function makeProject(overrides: { from?: string; wrangler?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ email: { from: overrides.from ?? 'noreply@mail.acme.com' } }),
  );
  writeFileSync(join(root, 'wrangler.jsonc'), overrides.wrangler ?? INITIAL_WRANGLER);
  mkdirSync(join(root, 'email'));
  writeFileSync(join(root, 'email', 'support+[ticket].ts'), 'export default () => {};\n');
  writeFileSync(join(root, 'email', '_default.ts'), 'export default () => {};\n');
  return root;
}

/** The transcript project's fakes, with the apply-side entries overridable. */
function transcriptDeps(
  extra: {
    runnerTable?: Record<string, EmailWranglerRunResult>;
    fetchTable?: Record<string, () => Response>;
    mx?: Record<string, Array<string>>;
  } = {},
) {
  const calls: Array<Call> = [];
  const fetchCalls: Array<FetchCall> = [];
  const printed: Array<string> = [];
  const runnerTable: Record<string, EmailWranglerRunResult> = {
    'whoami --json': fixture('whoami'),
    'email routing settings mail.acme.com': zoneNotFound('mail.acme.com'),
    'email routing settings acme.com': routingSettings('acme.com', 'ready'),
    'email routing rules list acme.com': fixture('routing-rules-list-void.cloud'),
    'email sending settings mail.acme.com': sendingNotFound('mail.acme.com'),
    ...extra.runnerTable,
  };
  const fetchTable: Record<string, () => Response> = {
    'GET /zones?name=acme.com': () =>
      jsonResponse(200, {
        success: true,
        result: [{ id: ZONE_ID, name: 'acme.com', type: 'full', account: { id: ACCOUNT } }],
      }),
    [`GET /zones/${ZONE_ID}/email/routing`]: () =>
      jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: false } }),
    ...extra.fetchTable,
  };
  const deps = {
    runWrangler: fakeRunner(runnerTable, calls),
    getSessionBearer: async () => BEARER,
    fetchImpl: fakeFetch(fetchTable, fetchCalls),
    dns: fakeDns(extra.mx ?? { 'acme.com': ['aspmx.l.google.com'] }),
    print: (block: string) => {
      printed.push(block);
    },
  };
  return { deps, calls, fetchCalls, printed };
}

function readJsonc(path: string): Record<string, unknown> {
  // The writer preserves the comment; strip it for the structural assertion.
  const text = readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as Record<string, unknown>;
}

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Workers Free AFTER a `setup` that was refused Email Sending: the binding, `addresses`
 * and the sender var are committed, routing + subaddressing are on, the rule exists, and
 * `sending settings` still answers not-found — the same answer a Paid account that never
 * onboarded gives. The committed binding is the memory of the refusal (`preflightEmail`),
 * so every row reads ready; the onboarding is the one retry `setup` offers on its own
 * prompt, and the state `status` must call set up.
 */
function freeAfterSetup(extra: { runnerTable?: Record<string, EmailWranglerRunResult> } = {}) {
  const root = makeProject({
    wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
  "vars": { "__VOID_EMAIL_FROM": "noreply@mail.acme.com" },
}
`,
  });
  roots.push(root);
  const fakes = transcriptDeps({
    runnerTable: {
      'email routing rules list acme.com': {
        status: 0,
        stdout:
          'Rule: 1a2b3c\n  Name:     support\n  Enabled:  true\n  Matchers: to:support@mail.acme.com\n  Actions:  worker:acme-support\n  Priority: 0\n\nCatch-all rule: disabled, action: drop\n',
        stderr: BETA_WARNING,
      },
      ...extra.runnerTable,
    },
    fetchTable: {
      [`GET /zones/${ZONE_ID}/email/routing`]: () =>
        jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
    },
    mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
  });
  return { root, configPath: join(root, 'wrangler.jsonc'), ...fakes };
}
const RETRY_PROMPT =
  'Onboard mail.acme.com for Email Sending? Inbound already works; onboarding needs Workers Paid.';
const sendingRefused: EmailWranglerRunResult = {
  status: 1,
  stdout: '',
  stderr: `${BETA_WARNING}✘ [ERROR] A request to the Cloudflare API (/zones/${ZONE_ID}/email/sending/subdomains) failed.\n\n  something went wrong [code: 10105]\n`,
};

describe('void email setup --platform cloudflare', () => {
  it('first run: checklist, one confirm, exact argv + REST calls, wrangler.jsonc written', async () => {
    const root = makeProject();
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
      fetchTable: {
        [`POST /zones/${ZONE_ID}/email/routing/dns`]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const confirms: Array<string> = [];

    const code = await run(root, 'setup', {
      ...deps,
      isInteractive: true,
      confirm: async (message) => {
        confirms.push(message);
        return true;
      },
    });

    expect(code).toBe(0);
    expect(confirms).toEqual(['Set up email on mail.acme.com?']);

    // Every wrangler child carries the deploy's config pin; the writes come after the reads.
    expect(calls.map((c) => c.args)).toEqual([
      ['whoami', '--json', '-c', configPath, '--env='],
      ['email', 'routing', 'settings', 'mail.acme.com', '-c', configPath, '--env='],
      ['email', 'routing', 'settings', 'acme.com', '-c', configPath, '--env='],
      ['email', 'routing', 'rules', 'list', 'acme.com', '-c', configPath, '--env='],
      ['email', 'sending', 'settings', 'mail.acme.com', '-c', configPath, '--env='],
      ['email', 'sending', 'enable', 'mail.acme.com', '-c', configPath, '--env='],
    ]);
    expect(calls.every((c) => c.capture)).toBe(true);
    expect(fetchCalls.map((c) => `${c.method} ${c.url.slice(c.url.indexOf('/zones'))}`)).toEqual([
      'GET /zones?name=acme.com',
      `GET /zones/${ZONE_ID}/email/routing`,
      `POST /zones/${ZONE_ID}/email/routing/dns`,
      `PATCH /zones/${ZONE_ID}/email/routing`,
    ]);
    for (const call of fetchCalls) {
      expect(call.headers.Authorization).toBe(`Bearer ${BEARER}`);
      expect(call.url).not.toContain(BEARER);
    }

    // The root config: binding + addresses + sender var, comment and siblings intact.
    const written = readFileSync(configPath, 'utf-8');
    expect(written).toContain('// the pinned account');
    expect(readJsonc(configPath)).toEqual({
      account_id: ACCOUNT,
      name: 'acme-support',
      compatibility_date: '2026-01-01',
      send_email: [{ name: 'SEND_EMAIL' }],
      addresses: ['support@mail.acme.com'],
      vars: { __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
    });

    // The checklist came before the prompt; the ✔ rows and the address map after.
    const output = printed.join('\n');
    expect(printed[0]).toContain('Email in use   email/support+[ticket].ts · email/_default.ts');
    expect(printed[0]).toContain('+ enable Email Routing on mail.acme.com');
    expect(printed[0]).toContain('! email/_default.ts');
    expect(output).toContain('✔ routing   mail.acme.com enabled');
    expect(output).toContain('✔ sending   mail.acme.com onboarded');
    expect(output).toContain('✔ config    wrangler.jsonc updated');
    expect(printed.at(-1)).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
    for (const block of printed) {
      expect(block).not.toContain(BEARER);
    }
  });

  it('declined: nothing is written or called after the checklist', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const { deps, calls, fetchCalls } = transcriptDeps();

    const code = await run(root, 'setup', {
      ...deps,
      isInteractive: true,
      confirm: async () => false,
    });

    expect(code).toBe(0);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(calls.map((c) => c.args[0])).toEqual(['whoami', 'email', 'email', 'email', 'email']);
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('non-interactive and not ready: checklist, exit 1, no writes (CI cannot press Enter)', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const { deps, calls, fetchCalls, printed } = transcriptDeps();
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(printed[0]).toContain(
      'This changes YOUR Cloudflare account. acme.com itself is not touched.',
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('an `all` blocker (foreign MX on the apex path) exits 1 without a prompt', async () => {
    const root = makeProject({ from: 'noreply@acme.com' });
    roots.push(root);
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: {
        'email routing settings acme.com': routingSettings('acme.com', 'unconfigured', false),
        'email sending settings acme.com': sendingNotFound('acme.com'),
      },
    });
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: true, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(printed[0]).toContain(
      '✘ acme.com already receives mail (aspmx.l.google.com). Void never enables routing over live mail. Use something@mail.acme.com.',
    );
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a bearer failure keeps going: dashboard fallback printed, addresses withheld, exit 1', async () => {
    const root = makeProject();
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, printed } = transcriptDeps({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
    });

    const code = await run(root, 'setup', {
      ...deps,
      getSessionBearer: async () => null,
      isInteractive: true,
      confirm: async () => true,
    });

    expect(code).toBe(1);
    const output = printed.join('\n');
    expect(output).toContain('Email → Settings → Subdomains');
    expect(output).toContain('addresses withheld this run');
    // Sending was onboarded, so the binding + sender var are written; `addresses` is not.
    const config = readJsonc(configPath);
    expect(config.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(config.vars).toEqual({ __VOID_EMAIL_FROM: 'noreply@mail.acme.com' });
    expect(config.addresses).toBeUndefined();
  });

  it('routing came up but the subaddressing PATCH was refused: exit 1, subaddressing named, addresses withheld', async () => {
    // The apex path: `wrangler email routing enable acme.com` succeeds, then the bearer
    // PATCH `{ support_subaddress: true }` is refused. `addresses` is withheld (no bearer
    // call may fail, decision 11), so the next deploy creates NO rule, and until the flag
    // is on `support+T-42@` matches no rule for `support@` either. Routing alone is not
    // "set up": the exit and the verdict line must say what is missing and to rerun.
    const root = makeProject({ from: 'noreply@acme.com' });
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: {
        'email routing settings acme.com': routingSettings('acme.com', 'unconfigured', false),
        'email sending settings acme.com': sendingNotFound('acme.com'),
        'email routing enable acme.com': {
          status: 0,
          stdout: 'Email Routing enabled for acme.com (status: ready)\n',
          stderr: BETA_WARNING,
        },
        'email sending enable acme.com': sendingEnabled('acme.com'),
      },
      fetchTable: {
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(403, {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
          }),
      },
      mx: {},
    });
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(1);
    expect(calls.map((c) => c.args.slice(0, 4))).toContainEqual([
      'email',
      'routing',
      'enable',
      'acme.com',
    ]);
    expect(fetchCalls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    const output = printed.join('\n');
    expect(output).toContain('✔ routing   acme.com enabled');
    expect(output).toContain(
      '✘ routing   subaddressing on acme.com: Cloudflare answered 403 [code: 10000] — Authentication error',
    );
    expect(output).toContain('addresses withheld this run (session-bearer step failed)');
    // Routing DID come up, so the binding + sender var are written; `addresses` is not.
    const config = readJsonc(configPath);
    expect(config.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect(config.vars).toEqual({ __VOID_EMAIL_FROM: 'noreply@acme.com' });
    expect(config.addresses).toBeUndefined();
    // The verdict: not "set up" — what is missing, and the rerun.
    const verdict = logged.lines.join('\n');
    expect(verdict).not.toContain('Email set up on');
    expect(verdict).toContain('subaddressing');
    expect(verdict).toContain('rerun `void email setup --platform cloudflare`');
  });

  it('Workers Free: routing + subaddressing on, sending refused → exit 0 with the plan hint, addresses written', async () => {
    // Sending onboarding needs Workers Paid, which Void cannot buy; inbound is complete and
    // `addresses` is committed, which is all `setup` exists to do (CI commits the file).
    // The plan hint and the `(verified destinations only)` marker are the warning.
    const root = makeProject();
    roots.push(root);
    const configPath = join(root, 'wrangler.jsonc');
    const { deps, printed } = transcriptDeps({
      runnerTable: {
        'email sending enable mail.acme.com': {
          status: 1,
          stdout: '',
          stderr: `${BETA_WARNING}✘ [ERROR] A request to the Cloudflare API (/zones/${ZONE_ID}/email/sending/subdomains) failed.\n\n  something went wrong [code: 10105]\n`,
        },
      },
      fetchTable: {
        [`POST /zones/${ZONE_ID}/email/routing/dns`]: () =>
          jsonResponse(200, { success: true, result: { name: 'mail.acme.com' } }),
        [`PATCH /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { support_subaddress: true } }),
      },
    });
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    const output = printed.join('\n');
    expect(output).toContain('✔ routing   mail.acme.com enabled');
    expect(output).toContain('✔ routing   subaddressing on for acme.com');
    expect(output).toContain(
      '! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(output).toContain(SENDING_FREE_PLAN_HINT);
    expect(printed.at(-1)).toContain(
      'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
    );
    expect(readJsonc(configPath).addresses).toEqual(['support@mail.acme.com']);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`: the onboarding is offered as its own prompt; refused again → hint, config unchanged, exit 0', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = freeAfterSetup({
      runnerTable: { 'email sending enable mail.acme.com': sendingRefused },
    });
    const before = readFileSync(configPath, 'utf-8');
    const confirms: Array<string> = [];
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', {
        ...deps,
        isInteractive: true,
        confirm: async (message) => {
          confirms.push(message);
          return true;
        },
      });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirms).toEqual([RETRY_PROMPT]);
    // The checklist before the prompt: the row says what works, the retry is the one change.
    expect(printed[0]).toContain(
      '    sending   mail.acme.com  not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare',
    );
    expect(printed[0]).toContain('    + onboard mail.acme.com for Email Sending');
    expect(printed[0]).not.toContain('+ enable Email Routing');
    expect(printed[0]).not.toContain('+ wrangler.jsonc');
    // ONE account write — the onboarding — and no bearer write.
    expect(calls.filter((c) => c.args.includes('enable')).map((c) => c.args.slice(0, 4))).toEqual([
      ['email', 'sending', 'enable', 'mail.acme.com'],
    ]);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    const output = printed.join('\n');
    expect(output).toContain(
      '! sending   mail.acme.com not onboarded [code: 10105] — account is not entitled to Email Sending',
    );
    expect(output).toContain(SENDING_FREE_PLAN_HINT);
    expect(printed.at(-1)).toContain(
      'outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
    );
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`, upgraded to Workers Paid: the retry onboards the domain', async () => {
    const { root, configPath, deps, calls, printed } = freeAfterSetup({
      runnerTable: { 'email sending enable mail.acme.com': sendingEnabled('mail.acme.com') },
    });
    const before = readFileSync(configPath, 'utf-8');
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', { ...deps, isInteractive: true, confirm: async () => true });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(calls.filter((c) => c.args.includes('enable'))).toHaveLength(1);
    expect(printed.join('\n')).toContain('✔ sending   mail.acme.com onboarded');
    expect(printed.at(-1)).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(logged.lines.join('\n')).toContain('Email set up on mail.acme.com.');
  });

  it('Workers Free after `setup`, retry declined: nothing changed, no `enable` call, no write', async () => {
    const { root, configPath, deps, calls, fetchCalls } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf-8');
    const confirms: Array<string> = [];
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'setup', {
        ...deps,
        isInteractive: true,
        confirm: async (message) => {
          confirms.push(message);
          return false;
        },
      });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirms).toEqual([RETRY_PROMPT]);
    expect(logged.lines).toContain('Nothing changed.');
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('Workers Free after `setup`, non-interactive: the retry is never run unasked — exit 1, no `enable` call', async () => {
    const { root, configPath, deps, calls } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf-8');
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('second run, everything ready: no prompt, zero writes, config unchanged, exit 0', async () => {
    const root = makeProject({
      wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
  "vars": { "__VOID_EMAIL_FROM": "noreply@mail.acme.com" },
}
`,
    });
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const { deps, calls, fetchCalls, printed } = transcriptDeps({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout:
            'Rule: 1a2b3c\n  Name:     support\n  Enabled:  true\n  Matchers: to:support@mail.acme.com\n  Actions:  worker:acme-support\n  Priority: 0\n\nCatch-all rule: disabled, action: drop\n',
          stderr: BETA_WARNING,
        },
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                ${ZONE_ID}\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: {
        [`GET /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
      },
      mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
    });
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'setup', { ...deps, isInteractive: false, confirm });

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);
    // Every row reads ready; the only remaining line is the `!` for the refused catch-all.
    expect(printed[0]).toContain('    rules     support@mail.acme.com → acme-support   (ready)');
    expect(printed[0]).not.toContain('\n    + ');
  });

  it('refuses without email.from before touching wrangler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
    roots.push(root);
    writeFileSync(join(root, 'void.json'), '{}');
    writeFileSync(join(root, 'wrangler.jsonc'), INITIAL_WRANGLER);
    const { deps, calls, fetchCalls } = transcriptDeps();

    const code = await run(root, 'setup', { ...deps, isInteractive: true });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(fetchCalls).toEqual([]);
  });

  it('refuses without a pinned account before touching wrangler', async () => {
    const root = makeProject({ wrangler: '{ "name": "acme-support" }\n' });
    roots.push(root);
    const saved = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      const { deps, calls } = transcriptDeps();
      const code = await run(root, 'setup', { ...deps, isInteractive: true });
      expect(code).toBe(1);
      expect(calls).toEqual([]);
    } finally {
      if (saved !== undefined) {
        process.env.CLOUDFLARE_ACCOUNT_ID = saved;
      }
    }
  });
});

describe('void email status --platform cloudflare', () => {
  it('not ready: status rows + address map, exit 1, read-only', async () => {
    const root = makeProject();
    roots.push(root);
    const before = readFileSync(join(root, 'wrangler.jsonc'), 'utf-8');
    const { deps, calls, fetchCalls, printed } = transcriptDeps();
    const confirm = vi.fn(async () => true);

    const code = await run(root, 'status', { ...deps, isInteractive: true, confirm });

    expect(code).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(before);

    expect(printed).toHaveLength(2);
    expect(printed[0]).toContain('    routing   mail.acme.com  not enabled · subaddressing off');
    expect(printed[0]).toContain('    binding   SEND_EMAIL             (absent)');
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts   (no rule yet)',
        '    outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
      ].join('\n'),
    );
  });

  it('Workers Free after `setup` (binding committed, sending still not onboarded): exit 0, the row says what works and how to retry', async () => {
    const { root, configPath, deps, calls, fetchCalls, printed } = freeAfterSetup();
    const before = readFileSync(configPath, 'utf-8');
    const confirm = vi.fn(async () => true);
    const logged = captureLog();
    let code: number;
    try {
      code = await run(root, 'status', { ...deps, isInteractive: true, confirm });
    } finally {
      logged.restore();
    }

    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.args.includes('enable'))).toBe(false);
    expect(fetchCalls.every((c) => c.method === 'GET')).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(printed[0]).toContain(
      '    sending   mail.acme.com  not onboarded — verified destinations only; after upgrading to Workers Paid run void email setup --platform cloudflare',
    );
    expect(printed[0]).toContain('    binding   SEND_EMAIL             (present)');
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com   (verified destinations only)',
      ].join('\n'),
    );
    expect(logged.lines.join('\n')).toContain('Email is set up on mail.acme.com.');
    expect(logged.lines.join('\n')).not.toContain('not set up');
  });

  it("ready but the rule not created yet (right after `setup`): exit 0 — rules are the next deploy's", async () => {
    const root = makeProject({
      wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
  "vars": { "__VOID_EMAIL_FROM": "noreply@mail.acme.com" },
}
`,
    });
    roots.push(root);
    const { deps, printed } = transcriptDeps({
      runnerTable: {
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                ${ZONE_ID}\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: {
        [`GET /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
      },
      mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
    });

    const code = await run(root, 'status', { ...deps, isInteractive: false });

    expect(code).toBe(0);
    expect(printed[1]).toContain(
      '    inbound   support@mail.acme.com  →  email/support+[ticket].ts   (no rule yet)',
    );
  });

  it('an API-token session reads ready like a login session does (CI on CLOUDFLARE_API_TOKEN)', async () => {
    const root = makeProject({
      wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
  "vars": { "__VOID_EMAIL_FROM": "noreply@mail.acme.com" },
}
`,
    });
    roots.push(root);
    const { deps, calls } = transcriptDeps({
      runnerTable: {
        'whoami --json': {
          status: 0,
          stdout: JSON.stringify({
            loggedIn: true,
            authType: 'User API Token',
            accounts: [{ id: ACCOUNT, name: 'Acme' }],
          }),
          stderr: '',
        },
        'email routing rules list acme.com': {
          status: 0,
          stdout:
            'Rule: 1a2b3c\n  Name:     support\n  Enabled:  true\n  Matchers: to:support@mail.acme.com\n  Actions:  worker:acme-support\n  Priority: 0\n\nCatch-all rule: disabled, action: drop\n',
          stderr: BETA_WARNING,
        },
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                ${ZONE_ID}\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: {
        [`GET /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
      },
      mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
    });

    const code = await run(root, 'status', { ...deps, isInteractive: false });

    expect(code).toBe(0);
    expect(calls.some((c) => c.args[0] === 'email')).toBe(true);
  });

  it('ready: exit 0 and the routed address map', async () => {
    const root = makeProject({
      wrangler: `{
  "account_id": "${ACCOUNT}",
  "name": "acme-support",
  "send_email": [{ "name": "SEND_EMAIL" }],
  "addresses": ["support@mail.acme.com"],
}
`,
    });
    roots.push(root);
    const { deps, printed } = transcriptDeps({
      runnerTable: {
        'email routing rules list acme.com': {
          status: 0,
          stdout:
            'Rule: 1a2b3c\n  Name:     support\n  Enabled:  true\n  Matchers: to:support@mail.acme.com\n  Actions:  worker:acme-support\n  Priority: 0\n\nCatch-all rule: disabled, action: drop\n',
          stderr: BETA_WARNING,
        },
        'email sending settings mail.acme.com': {
          status: 0,
          stdout: `Email Sending for mail.acme.com:\n  Enabled:            true\n  Tag:                ${ZONE_ID}\n`,
          stderr: BETA_WARNING,
        },
      },
      fetchTable: {
        [`GET /zones/${ZONE_ID}/email/routing`]: () =>
          jsonResponse(200, { success: true, result: { enabled: true, support_subaddress: true } }),
      },
      mx: { 'acme.com': ['aspmx.l.google.com'], 'mail.acme.com': ['route1.mx.cloudflare.net'] },
    });

    const code = await run(root, 'status', { ...deps, isInteractive: false });

    expect(code).toBe(0);
    expect(printed[1]).toBe(
      [
        '    inbound   support@mail.acme.com  →  email/support+[ticket].ts',
        '    outbound  sendEmail() from noreply@mail.acme.com',
      ].join('\n'),
    );
  });
});

describe('void email setup|status without --platform cloudflare', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new ExitSignal(code);
    }) as never);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('explains that both are Mode B commands today and exits 1 before any platform call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-email-cli-'));
    roots.push(root);
    for (const subcommand of ['setup', 'status'] as const) {
      await expect(runEmailCommand(root, { subcommand })).rejects.toBeInstanceOf(ExitSignal);
      expect(exitSpy).toHaveBeenLastCalledWith(1);
      // `--platform void` is that default spelled out: the same exit, still no platform call.
      await expect(runEmailCommand(root, { subcommand, platform: 'void' })).rejects.toBeInstanceOf(
        ExitSignal,
      );
      expect(exitSpy).toHaveBeenLastCalledWith(1);
    }
  });
});
