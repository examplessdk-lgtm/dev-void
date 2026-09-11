import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileRouteTable } from '../../src/router/compile.ts';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import {
  compileEmailPattern,
  hasEmailHandlers,
  scanEmailHandlers,
  scanEmailHandlersSync,
} from '../../src/router/email.ts';
import {
  buildReplyMessage,
  createMessageProxy,
  defineEmail,
  parseEmail,
  ParseEmailError,
  replyEmail,
  type EmailEnvelope,
} from '../../src/runtime/email/inbound.ts';
import { createInboundTestHarness } from '../../src/runtime/email/testing.ts';
import { envContext } from '../../src/runtime/env-raw.ts';

const TMP = join(import.meta.dirname, '.tmp-email-inbound');

function setupRoot(files: Record<string, string>): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'email'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const abs = join(TMP, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return TMP;
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('scanEmailHandlers', () => {
  it('returns empty when no email/ files exist', async () => {
    const root = setupRoot({});
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses).toEqual([]);
    expect(scan.defaultHandler).toBeUndefined();
    expect(hasEmailHandlers(scan)).toBe(false);
  });

  it('detects per-address handlers under email/', async () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
      'email/billing.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['billing', 'support']);
    expect(scan.addresses[0].filePath).toBe('billing.ts');
    expect(hasEmailHandlers(scan)).toBe(true);
  });

  it('detects email/_default.ts as fallback', async () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
      'email/_default.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.defaultHandler).toBe('_default.ts');
    expect(scan.addresses.map((a) => a.address)).toEqual(['support']);
  });

  it('lowercases address names for case-insensitive routing', async () => {
    const root = setupRoot({
      'email/Support.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses[0].address).toBe('support');
  });

  it('ignores nested folders', async () => {
    const root = setupRoot({
      'email/sub/nested.ts': 'export default () => {}',
      'email/support.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['support']);
  });

  it('sync variant returns the same shape', () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
    });
    const scan = scanEmailHandlersSync(root);
    expect(scan.addresses[0].address).toBe('support');
  });

  it('compiles tagged + dynamic patterns and orders by specificity', async () => {
    const root = setupRoot({
      'email/support.ts': 'export default () => {}',
      'email/support+[ticket].ts': 'export default () => {}',
      'email/[user].ts': 'export default () => {}',
      'email/[user]+[tag].ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses.map((a) => a.address)).toEqual([
      'support+[ticket]',
      'support',
      '[user]+[tag]',
      '[user]',
    ]);
    expect(scan.addresses.map((a) => a.pattern.kind)).toEqual([
      'static-tag',
      'static',
      'dynamic-tag',
      'dynamic',
    ]);
    expect(scan.addresses[0].pattern.regexSource).toBe('^support\\+([^+@]+)$');
    expect(scan.addresses[0].pattern.paramNames).toEqual(['ticket']);
    expect(scan.addresses[2].pattern.regexSource).toBe('^([^+@]+)\\+([^+@]+)$');
    expect(scan.addresses[2].pattern.paramNames).toEqual(['user', 'tag']);
  });

  it('skips files with invalid pattern shapes', async () => {
    const root = setupRoot({
      'email/support+ticket+extra.ts': 'export default () => {}', // two `+`
      'email/Bad Name.ts': 'export default () => {}', // space
      'email/[bad-name].ts': 'export default () => {}', // hyphen in param
      'email/ok.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.addresses.map((a) => a.address)).toEqual(['ok']);
  });
});

describe('compileEmailPattern', () => {
  it('compiles static address', () => {
    expect(compileEmailPattern('support')).toEqual({
      kind: 'static',
      regexSource: '^support$',
      paramNames: [],
    });
  });

  it('compiles static + tag', () => {
    expect(compileEmailPattern('support+[ticket]')).toEqual({
      kind: 'static-tag',
      regexSource: '^support\\+([^+@]+)$',
      paramNames: ['ticket'],
    });
  });

  it('compiles dynamic', () => {
    expect(compileEmailPattern('[user]')).toEqual({
      kind: 'dynamic',
      regexSource: '^([^+@]+)$',
      paramNames: ['user'],
    });
  });

  it('compiles dynamic + tag', () => {
    expect(compileEmailPattern('[user]+[tag]')).toEqual({
      kind: 'dynamic-tag',
      regexSource: '^([^+@]+)\\+([^+@]+)$',
      paramNames: ['user', 'tag'],
    });
  });

  it('escapes literal dots', () => {
    expect(compileEmailPattern('alerts.ops')).toEqual({
      kind: 'static',
      regexSource: '^alerts\\.ops$',
      paramNames: [],
    });
  });

  it('returns null for too many `+` separators', () => {
    expect(compileEmailPattern('a+b+c')).toBeNull();
  });

  it('returns null for invalid literal chars', () => {
    expect(compileEmailPattern('hello world')).toBeNull();
  });

  it('lowercases uppercase basenames before compilation', () => {
    // Patterns are lowercased to match the lowercased recipient — uppercase
    // in the filename is fine, just normalized.
    expect(compileEmailPattern('[Foo]')?.paramNames).toEqual(['foo']);
    expect(compileEmailPattern('Support')?.regexSource).toBe('^support$');
  });

  it('returns null for invalid param shapes', () => {
    expect(compileEmailPattern('[1abc]')).toBeNull(); // starts with digit
    expect(compileEmailPattern('[]')).toBeNull(); // empty
  });
});

describe('defineEmail', () => {
  it('is an identity helper that preserves the handler', () => {
    const handler = defineEmail(async () => {});
    expect(typeof handler).toBe('function');
  });
});

describe('parseEmail', () => {
  it('parses a minimal RFC 5322 message via postal-mime', async () => {
    const raw =
      'From: a@x.dev\r\n' +
      'To: b@y.dev\r\n' +
      'Subject: Hello\r\n' +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      '\r\n' +
      'Hi there\r\n';
    const message = {
      from: 'a@x.dev',
      to: 'b@y.dev',
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        },
      }),
    } as unknown as ForwardableEmailMessage;
    const parsed = await parseEmail(message);
    expect(parsed.subject).toBe('Hello');
    expect(parsed.from?.address).toBe('a@x.dev');
    expect(parsed.text?.trim()).toBe('Hi there');
  });

  it('rejects messages over the size cap before reading the stream', async () => {
    const message = {
      from: 'a@x.dev',
      to: 'b@y.dev',
      rawSize: 11 * 1024 * 1024,
      raw: new ReadableStream(),
    } as unknown as ForwardableEmailMessage;
    await expect(parseEmail(message)).rejects.toThrow(/exceeds maximum/);
  });
});

describe('compileRouteTable (email)', () => {
  const baseScan = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
  // `emailDir` rides on `CompileOptions` rather than `compileRouteTable`'s
  // positional list — see the note on the field in router/compile.ts.
  const baseOptions = {
    honoPath: 'hono',
    responsePath: 'void/response',
    handlerPath: 'void/handler',
    runtimeEnvPath: 'void/_env',
    projectRoot: '/project',
    homeDir: '/home/test',
    reactRefresh: false,
    auth: null,
    nodeTarget: false,
    emailDir: '/e',
  };

  it('emits __emailHandler with _default only', () => {
    const code = compileRouteTable(
      { ...baseScan, email: { addresses: [], defaultHandler: '_default.ts' } },
      '/r',
      '/m',
      '/j',
      '/q',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
    );
    expect(code).toContain('export async function __emailHandler');
    expect(code).toContain('"/e/_default.ts"');
    expect(code).toContain('__emailDefault');
  });

  it('emits per-address dispatch via __emailPatterns regex table', () => {
    const code = compileRouteTable(
      {
        ...baseScan,
        email: {
          addresses: [
            {
              address: 'support',
              filePath: 'support.ts',
              pattern: { kind: 'static', regexSource: '^support$', paramNames: [] },
            },
            {
              address: 'billing',
              filePath: 'billing.ts',
              pattern: { kind: 'static', regexSource: '^billing$', paramNames: [] },
            },
          ],
        },
      },
      '/r',
      '/m',
      '/j',
      '/q',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
    );
    expect(code).toContain('__emailPatterns');
    expect(code).toContain('^support$');
    expect(code).toContain('^billing$');
    expect(code).toContain('"/e/support.ts"');
    expect(code).toContain('"/e/billing.ts"');
    expect(code).toContain('mod.default(message, env, ctx, { params');
  });

  it('emits param extraction for tagged + dynamic patterns', () => {
    const code = compileRouteTable(
      {
        ...baseScan,
        email: {
          addresses: [
            {
              address: 'support+[ticket]',
              filePath: 'support+[ticket].ts',
              pattern: {
                kind: 'static-tag',
                regexSource: '^support\\+([^+@]+)$',
                paramNames: ['ticket'],
              },
            },
            {
              address: '[user]',
              filePath: '[user].ts',
              pattern: { kind: 'dynamic', regexSource: '^([^+@]+)$', paramNames: ['user'] },
            },
          ],
        },
      },
      '/r',
      '/m',
      '/j',
      '/q',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
    );
    expect(code).toContain('"ticket"');
    expect(code).toContain('"user"');
    expect(code).toContain('^support\\\\+([^+@]+)$');
    expect(code).toContain('^([^+@]+)$');
  });

  it('omits the email block entirely when no handlers exist', () => {
    const code = compileRouteTable(
      { ...baseScan, email: { addresses: [] } },
      '/r',
      '/m',
      '/j',
      '/q',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
    );
    expect(code).not.toContain('__emailHandler');
  });
});

/**
 * Executes the GENERATED `__emailHandler` instead of asserting on its source.
 *
 * Every other codegen test here is string containment, which is exactly why the
 * double slug strip survived: `createMessageProxy` removed the `<slug>+` prefix
 * from `message.to`, the dispatcher removed it a second time, and the resulting
 * empty tag matched no pattern. Both halves were individually "correct" and the
 * seam between them was untested.
 */
function buildEmailDispatcher(
  code: string,
  modules: Record<string, { default: unknown }>,
): (message: unknown, env: unknown, ctx: unknown) => Promise<unknown> {
  const start = code.indexOf('const __email');
  const fnStart = code.indexOf('export async function __emailHandler');
  expect(start).toBeGreaterThan(-1);
  expect(fnStart).toBeGreaterThan(start);
  const fnEnd = code.indexOf('\n}\n', fnStart);
  expect(fnEnd).toBeGreaterThan(fnStart);

  const body = code
    .slice(start, fnEnd + 3)
    .replace('export async function __emailHandler', 'async function __emailHandler')
    .replace(/\(\) => import\((".*?")\)/g, '() => __modules[$1]');

  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function('__modules', `${body}\nreturn __emailHandler;`)(modules) as never;
}

describe('generated __emailHandler dispatch (behavioural)', () => {
  const baseScan = {
    routes: [],
    middleware: [],
    jobs: [],
    queues: [],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };

  const baseOptions = {
    honoPath: 'hono',
    responsePath: 'void/response',
    handlerPath: 'void/handler',
    runtimeEnvPath: 'void/_env',
    projectRoot: '/project',
    homeDir: '/home/test',
    reactRefresh: false,
    auth: null,
    nodeTarget: false,
    emailDir: '/e',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function compile(email: any): string {
    return compileRouteTable(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { ...baseScan, email } as any,
      '/r',
      '/m',
      '/j',
      '/q',
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      baseOptions as any,
    );
  }

  const SUPPORT = {
    addresses: [
      {
        address: 'support',
        filePath: 'support.ts',
        pattern: { kind: 'static', regexSource: '^support$', paramNames: [] },
      },
      {
        address: 'support+[ticket]',
        filePath: 'support+[ticket].ts',
        pattern: {
          kind: 'dynamic-tag',
          regexSource: '^support\\+([^+@]+)$',
          paramNames: ['ticket'],
        },
      },
    ],
    defaultHandler: undefined,
  };

  it('routes a platform recipient to its handler after createMessageProxy strips the slug', async () => {
    const calls: Array<{ to: string; params: unknown }> = [];
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': {
        default: (
          message: { to: string },
          _env: unknown,
          _ctx: unknown,
          info: { params: unknown },
        ) => {
          calls.push({ to: message.to, params: info.params });
        },
      },
      '/e/support+[ticket].ts': { default: () => calls.push({ to: 'WRONG', params: null }) },
    });

    // The wire recipient the platform delivers, for project slug `acme`.
    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    // The user-visible address has the slug removed - that is the DX contract.
    expect(message.to).toBe('support@mail.void.cloud');

    await dispatch(message, {}, {});

    expect(calls).toEqual([{ to: 'support@mail.void.cloud', params: {} }]);
  });

  it('captures the tag parameter from the wire recipient, not the stripped one', async () => {
    const seen: Array<unknown> = [];
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': { default: () => seen.push('static') },
      '/e/support+[ticket].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: unknown }) =>
          seen.push(info.params),
      },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+support+T-42@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    await dispatch(message, {}, {});

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('falls through when the recipient carries no <slug>+ prefix', async () => {
    // The platform router resolves the project FROM the slug prefix, so a bare
    // `support@` is never delivered to a worker. The dispatcher therefore
    // treats "no `+`" as "no tag" and falls through rather than guessing.
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'support@mail.void.cloud',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(hits).toEqual(['default']);
  });

  it('rejects an unmatched recipient when the app has no _default handler', async () => {
    const dispatch = buildEmailDispatcher(compile(SUPPORT), {
      '/e/support.ts': { default: () => undefined },
      '/e/support+[ticket].ts': { default: () => undefined },
    });

    const rejections: Array<string> = [];
    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+billing@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );
    (message as { setReject: (reason: string) => void }).setReject = (reason) => {
      rejections.push(reason);
    };

    await dispatch(message, {}, {});

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain('no handler matched recipient');
  });
});

describe('compileWorkerEntry (email)', () => {
  it('adds email export and import when hasEmail is true', () => {
    const code = compileWorkerEntry({ hasEmail: true });
    expect(code).toContain(', __emailHandler');
    expect(code).toContain(
      'async email(envelope) { return handleEmail(envelope, this.env, this.ctx); }',
    );
    expect(code).toContain('async function handleEmail');
  });

  it('omits the email export when hasEmail is false', () => {
    const code = compileWorkerEntry({ hasEmail: false });
    expect(code).not.toContain('handleEmail');
    expect(code).not.toContain('__emailHandler');
  });

  it('co-exists with queue export when both present', () => {
    const code = compileWorkerEntry({ hasQueues: true, hasEmail: true });
    expect(code).toContain('async queue(batch) { return __voidQueue(batch, this.env, this.ctx); }');
    expect(code).toContain(
      'async email(envelope) { return handleEmail(envelope, this.env, this.ctx); }',
    );
  });
});

describe('createInboundTestHarness', () => {
  it('routes to a static handler and passes empty params', async () => {
    let receivedInfo: { params: Record<string, string> } | undefined;
    const support = vi.fn(
      async (
        _m: ForwardableEmailMessage,
        _e: unknown,
        _c: ExecutionContext,
        info?: { params: Record<string, string> },
      ) => {
        receivedInfo = info;
      },
    );
    const harness = createInboundTestHarness({ routes: { support } });
    // Production: every recipient is `<slug>+<tag>@mail.void.cloud`; the
    // dispatcher strips through the first `+` before matching, so the
    // handler-side tag is `support`. Tests mirror the wire format.
    const result = await harness.deliver({ from: 'a@x.dev', to: 'myslug+support@app.dev' });
    expect(result.handler).toBe('support');
    expect(result.params).toEqual({});
    expect(support).toHaveBeenCalledTimes(1);
    expect(receivedInfo?.params).toEqual({});
  });

  it('routes to static + tag and extracts the tag param', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': handler } });
    const result = await harness.deliver({
      from: 'u@x.dev',
      to: 'myslug+support+abc-123@app.dev',
    });
    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'abc-123' });
  });

  it('routes to dynamic + tag and extracts both params', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { '[user]+[tag]': handler } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+alice+welcome@app.dev' });
    expect(result.params).toEqual({ user: 'alice', tag: 'welcome' });
  });

  it('prefers static-tag over static and dynamic', async () => {
    const staticTag = vi.fn(async () => {});
    const staticHandler = vi.fn(async () => {});
    const dynamic = vi.fn(async () => {});
    const harness = createInboundTestHarness({
      routes: {
        'support+[ticket]': staticTag,
        support: staticHandler,
        '[user]': dynamic,
      },
    });
    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+1@app.dev' });
    expect(staticTag).toHaveBeenCalled();
    expect(staticHandler).not.toHaveBeenCalled();
    expect(dynamic).not.toHaveBeenCalled();

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev' });
    expect(staticHandler).toHaveBeenCalled();

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+random@app.dev' });
    expect(dynamic).toHaveBeenCalled();
  });

  it('falls through to _default when no per-address pattern matches', async () => {
    const def = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { _default: def } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'unknown@app.dev' });
    expect(result.handler).toBe('_default');
    expect(def).toHaveBeenCalled();
  });

  it('prefers a matching per-address handler over _default', async () => {
    const def = vi.fn(async () => {});
    const support = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { support, _default: def } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev' });
    expect(result.handler).toBe('support');
    expect(support).toHaveBeenCalled();
    expect(def).not.toHaveBeenCalled();
  });

  it('returns undefined handler when nothing matches', async () => {
    const harness = createInboundTestHarness({ routes: {} });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'unknown@app.dev' });
    expect(result.handler).toBeUndefined();
  });

  it('walks back forward/reply when setReject fires later in the same dispatch', async () => {
    // Production: setReject is terminal — forward/reply queued before it
    // never execute on the real ForwardableEmailMessage. The harness
    // mirrors that by popping the prior entries off the public arrays so
    // assertions match what the real router would actually enact.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = defineEmail(async (message) => {
        await message.forward('ops@x.dev');
        message.setReject('not allowed');
      });
      const harness = createInboundTestHarness({ routes: { _default: handler } });
      await harness.deliver({ from: 'u@x.dev', to: 'anything@app.dev' });
      expect(harness.rejects).toEqual(['not allowed']);
      expect(harness.forwards).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('forward/reply');
    } finally {
      warn.mockRestore();
    }
  });

  it('setReject is terminal: forward/reply after setReject are dropped', async () => {
    // Production's createMessageProxy short-circuits forward/reply once
    // setReject has fired (warns + returns). The harness must mirror
    // that — without it, a buggy handler that calls setReject then
    // forward passes the harness tests but in production CF only
    // honors the reject and silently discards the forward.
    const handler = defineEmail(async (message) => {
      message.setReject('not allowed');
      await message.forward('ops@x.dev');
      await message.reply({ from: 'support@app.dev', to: 'u@x.dev' } as never);
    });
    const harness = createInboundTestHarness({ routes: { _default: handler } });
    await harness.deliver({ from: 'u@x.dev', to: 'anything@app.dev' });
    expect(harness.rejects).toEqual(['not allowed']);
    expect(harness.forwards).toEqual([]);
    expect(harness.replies).toEqual([]);
  });

  it('setReject is idempotent — subsequent setReject calls are dropped', async () => {
    const handler = defineEmail(async (message) => {
      message.setReject('first reason');
      message.setReject('second reason ignored');
    });
    const harness = createInboundTestHarness({ routes: { _default: handler } });
    await harness.deliver({ from: 'u@x.dev', to: 'anything@app.dev' });
    expect(harness.rejects).toEqual(['first reason']);
  });

  it('throws on invalid route key', () => {
    expect(() => createInboundTestHarness({ routes: { 'a+b+c': async () => {} } })).toThrow(
      /not a valid email pattern/,
    );
  });

  it('matches the recipient case-insensitively', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({ routes: { support: handler } });
    const result = await harness.deliver({ from: 'u@x.dev', to: 'MYSLUG+SUPPORT@APP.DEV' });
    expect(result.handler).toBe('support');
  });

  // The harness is the only thing a user tests their handler against, so a
  // captured tag has to arrive with the case production would give it. The
  // codegen twin of this assertion is 'captures the tag parameter from the
  // wire recipient, not the stripped one' above; the two must agree or a
  // green test suite says nothing about the deployed behavior.
  it('preserves the case of a captured tag, like the generated dispatcher', async () => {
    let seen: unknown;
    const harness = createInboundTestHarness({
      routes: {
        'support+[ticket]': async (
          _message: unknown,
          _env: unknown,
          _ctx: unknown,
          info?: { params: Record<string, string> },
        ) => {
          seen = info?.params;
        },
      },
    });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+support+T-42@app.dev' });

    expect(result.handler).toBe('support+[ticket]');
    expect(result.params).toEqual({ ticket: 'T-42' });
    expect(seen).toEqual({ ticket: 'T-42' });
  });
});

describe('harness rejects an unmatched delivery, like production', () => {
  // The generated dispatcher calls setReject when nothing matches and there
  // is no _default, so the sender gets an NDR. The harness used to return
  // silently, so a test for catch-all or anti-spam behavior could observe an
  // ACCEPTED message where deployment bounces it. Same divergence class as
  // the captured-tag casing bug: the harness has to mirror the dispatcher.
  it('records the reject when nothing matches and there is no _default', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+billing@app.dev' });

    expect(result.handler).toBeUndefined();
    expect(harness.rejects).toHaveLength(1);
    // The reason must match the dispatcher's byte for byte — it reaches the
    // sender's DSN. `__to` is the WIRE address, case preserved.
    expect(harness.rejects[0]).toBe(
      'no handler matched recipient "myslug+billing@app.dev" — add email/_default.ts to handle unmatched mail',
    );
  });

  it('uses the wire address with its original case in the reason', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    await harness.deliver({ from: 'u@x.dev', to: 'MySlug+Billing@App.Dev' });

    expect(harness.rejects[0]).toContain('"MySlug+Billing@App.Dev"');
  });

  it('does not reject when _default handles the unmatched message', async () => {
    const handler = vi.fn(async () => {});
    const harness = createInboundTestHarness({
      routes: { 'support+[ticket]': async () => {}, _default: handler },
    });

    const result = await harness.deliver({ from: 'u@x.dev', to: 'myslug+billing@app.dev' });

    expect(result.handler).toBe('_default');
    expect(harness.rejects).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a recipient with no tag when there is no _default', async () => {
    const harness = createInboundTestHarness({ routes: { 'support+[ticket]': async () => {} } });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug@app.dev' });

    expect(harness.rejects).toHaveLength(1);
    expect(harness.rejects[0]).toContain('"myslug@app.dev"');
  });
});

describe('harness headers match the bytes, like production', () => {
  // In production `buildEnvelope` copies every wire header verbatim, so
  // `message.headers` and `message.raw` agree by construction. The harness
  // rebuilt `headers` from `input` alone, so its own synthetic MIME carried
  // a Message-ID that its own `headers` did not expose — and `replyEmail`
  // reads exactly that header, so a harness reply came out UNTHREADED while
  // the same handler threaded correctly in production. Third divergence of
  // this shape on this feature, after captured-param casing and the
  // unmatched-delivery reject.
  it('exposes the generated Message-ID, so replyEmail threads', async () => {
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Message-ID');
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', subject: 'Help' });

    expect(seen).toMatch(/^<.+@.+>$/);
  });

  it('exposes headers from a caller-supplied raw MIME', async () => {
    // The `raw:` override hands the harness exact wire bytes. Ignoring their
    // headers is the sharpest form of the divergence: the caller supplied
    // precisely what production would receive.
    const raw = [
      'Message-ID: <fromraw@remote.dev>',
      'From: u@x.dev',
      'To: myslug+support@app.dev',
      'Subject: Help',
      'X-Custom: kept',
      '',
      'body',
      '',
    ].join('\r\n');
    let seen: Record<string, string | null> = {};
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = {
            id: message.headers.get('Message-ID'),
            custom: message.headers.get('X-Custom'),
          };
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', raw });

    expect(seen.id).toBe('<fromraw@remote.dev>');
    expect(seen.custom).toBe('kept');
  });

  it('exposes Subject the way the wire carries it, not decoded', async () => {
    // `buildMime` RFC 2047-encodes a non-ASCII subject and production hands
    // the handler that encoded form. A handler comparing
    // `message.headers.get('Subject')` — the pattern the guide shows — must
    // see the same string in both places.
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Subject');
        },
      },
    });

    await harness.deliver({ from: 'u@x.dev', to: 'myslug+support@app.dev', subject: 'café' });

    expect(seen).toBe('=?UTF-8?B?Y2Fmw6k=?=');
  });

  it('lets an explicit input header win over the bytes', async () => {
    let seen: string | null = null;
    const harness = createInboundTestHarness({
      routes: {
        _default: async (message: { headers: Headers }) => {
          seen = message.headers.get('Message-ID');
        },
      },
    });

    await harness.deliver({
      from: 'u@x.dev',
      to: 'myslug+support@app.dev',
      subject: 'Help',
      headers: { 'Message-ID': '<explicit@remote.dev>' },
    });

    expect(seen).toBe('<explicit@remote.dev>');
  });
});

describe('reply threading survives a hostile inbound header', () => {
  // `buildReplyMessage` threads the inbound `Message-ID` and `References`
  // into the reply verbatim, and those are controlled by whoever sent the
  // mail. The 998-octet line guard would therefore let a remote sender make
  // an app's reply throw, with the app at fault for nothing. Threading is
  // best-effort, so an unusable value is dropped and the reply still goes.
  const HUGE = 'x'.repeat(1100);

  function inbound(headers: Record<string, string>) {
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    return createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers,
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    ).message;
  }

  it('drops an unusable Message-ID rather than failing the reply', async () => {
    const message = inbound({ 'message-id': `<${HUGE}@remote.dev>`, subject: 'hi' });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    const text = new TextDecoder().decode(reply.raw);
    expect(text).toContain('Subject: Re: hi');
    expect(text).not.toContain(HUGE);
    expect(Math.max(...text.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(998);
  });

  it('drops an unusable References chain rather than failing the reply', async () => {
    const message = inbound({ references: `<${HUGE}@remote.dev>`, subject: 'hi' });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    expect(
      Math.max(
        ...new TextDecoder()
          .decode(reply.raw)
          .split('\r\n')
          .map((l) => l.length),
      ),
    ).toBeLessThanOrEqual(998);
  });

  it('still threads a normal Message-ID', async () => {
    const message = inbound({ 'message-id': '<abc123@remote.dev>', subject: 'hi' });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    const text = new TextDecoder().decode(reply.raw);
    expect(text).toContain('In-Reply-To: <abc123@remote.dev>');
    expect(text).toContain('References: <abc123@remote.dev>');
  });
});

describe('reply subject survives a hostile inbound header', () => {
  // The default reply subject is decoded from the inbound `Subject`, which
  // the remote sender controls. `normalizeEmail` rejects CR, LF and NUL and
  // `buildMime` rejects any line over 998 octets, so a subject carrying
  // either would make the app's reply throw — and in production that
  // rejects the whole delivery, replies AND forwards. Like threading, the
  // subject is best-effort: repair what can be repaired, fall back to
  // `Re:` for what cannot, and always send the reply.
  const FROM = 'acme+noreply@x.dev';

  function inbound(subject: string) {
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    return createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { subject },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    ).message;
  }

  function maxLine(reply: { raw: Uint8Array }): number {
    return Math.max(
      ...new TextDecoder()
        .decode(reply.raw)
        .split('\r\n')
        .map((l) => l.length),
    );
  }

  // The reviewer's case. `parseInt('0G', 16)` is 0, not NaN, so the old
  // predicate synthesised a NUL from a malformed escape. RFC 2045 §6.7 says
  // a robust decoder keeps the `=` and the following characters as-is.
  it('keeps a malformed Q escape literal instead of decoding half of it', async () => {
    const reply = await buildReplyMessage(inbound('=?UTF-8?Q?bad=0Gsubject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re: bad=0Gsubject');
  });

  it.each([
    ['a well-formed Q-encoded NUL', '=?UTF-8?Q?bad=00subject?='],
    ['a well-formed Q-encoded LF', '=?UTF-8?Q?bad=0Asubject?='],
    ['a well-formed Q-encoded CR', '=?UTF-8?Q?bad=0Dsubject?='],
    // base64('bad\0subject')
    ['a B-encoded NUL', '=?UTF-8?B?YmFkAHN1YmplY3Q=?='],
  ])('replaces %s with a space rather than failing the reply', async (_label, subject) => {
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe('Re: bad subject');
  });

  it('falls back to a bare Re: for an ASCII subject no line can hold', async () => {
    const reply = await buildReplyMessage(inbound('x'.repeat(1100)), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re:');
    expect(maxLine(reply)).toBeLessThanOrEqual(998);
  });

  // The fit check must not over-reject: a non-ASCII subject is chunked
  // into 75-character encoded-words that fold, however long it is.
  it('keeps a long non-ASCII subject, which encodes into foldable words', async () => {
    const subject = 'é'.repeat(600);
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe(`Re: ${subject}`);
    expect(maxLine(reply)).toBeLessThanOrEqual(998);
  });

  it('still prefixes an ordinary subject', async () => {
    const reply = await buildReplyMessage(inbound('=?UTF-8?Q?good=20subject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(reply.subject).toBe('Re: good subject');
  });
});

describe('parseEmail error contract', () => {
  // `PARSE_FAILED` was declared in the code union but never constructed, so
  // the one thing that does make postal-mime reject — a deeply nested
  // message — escaped as a bare Error carrying parser internals. The union
  // has to be honest: every code it names is reachable.
  it('wraps a parser rejection as PARSE_FAILED', async () => {
    // postal-mime refuses past 256 levels of nesting. Build one bomb that
    // trips exactly that, and nothing else.
    const depth = 300;
    let body = 'boom\r\n';
    for (let i = depth; i > 0; i--) {
      const boundary = `b${i}`;
      body =
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\n${body}\r\n--${boundary}--\r\n`;
    }
    const raw = new TextEncoder().encode(body);
    const { message } = createMessageProxy(
      { from: 'a@b.dev', to: 'acme+x@mail.void.cloud', headers: {}, raw, rawSize: raw.length },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseEmailError && e.code === 'PARSE_FAILED',
    );
  });

  it('still reports an oversized message as INBOUND_TOO_LARGE', async () => {
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    const { message } = createMessageProxy(
      {
        from: 'a@b.dev',
        to: 'acme+x@mail.void.cloud',
        headers: {},
        raw,
        rawSize: 100 * 1024 * 1024,
      },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseEmailError && e.code === 'INBOUND_TOO_LARGE',
    );
  });
});

describe('buildReplyMessage', () => {
  function makeMessage(headers: Record<string, string>): ForwardableEmailMessage {
    return {
      from: 'user@example.com',
      to: 'support@app.dev',
      headers: new Headers(headers),
      raw: new ReadableStream(),
      rawSize: 0,
    } as unknown as ForwardableEmailMessage;
  }

  // The platform mail domain is injected per environment, so the tests use a
  // non-production value: asserting on it proves the reply address came from
  // the binding and not from a baked-in constant.
  const MAIL_DOMAIN = 'mail.staging.void.cloud';

  // Most reply tests exercise the platform-defaulted `from = <slug>+noreply@…`
  // path. Set both platform bindings once via envContext so each test inside
  // this describe sees them without per-test boilerplate.
  function withSlug<T>(fn: () => T | Promise<T>): T | Promise<T> {
    return envContext.run({ __VOID_PROJECT_SLUG: 'myslug', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, fn);
  }

  it('defaults from/to/subject from the original message', async () => {
    await withSlug(async () => {
      const message = makeMessage({ Subject: 'Help me' });
      const built = await buildReplyMessage(message, { text: 'sure' });
      // F3: default `from` no longer mirrors `message.to` (which was the
      // platform-tagged `<slug>+<tag>@…` and is now slug-stripped to the
      // bare local-part). Reply-from is anchored to the platform sender
      // so the slug-pin allowlist accepts it.
      expect(built.from).toBe(`myslug+noreply@${MAIL_DOMAIN}`);
      expect(built.to).toBe('user@example.com');
      expect(built.subject).toBe('Re: Help me');
    });
  });

  it('does not double-prefix Re:', async () => {
    await withSlug(async () => {
      const message = makeMessage({ Subject: 'Re: existing thread' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: existing thread');
    });
  });

  it('handles missing subject gracefully', async () => {
    await withSlug(async () => {
      const message = makeMessage({});
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re:');
    });
  });

  it('decodes RFC 2047 encoded-word subjects before prepending Re:', async () => {
    await withSlug(async () => {
      // base64('日本語') in UTF-8 = "5pel5pys6Kqe"
      const message = makeMessage({ Subject: '=?UTF-8?B?5pel5pys6Kqe?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: 日本語');
    });
  });

  it('decodes Q-encoded subjects (RFC 2047 quoted-printable variant)', async () => {
    await withSlug(async () => {
      // =?UTF-8?Q?caf=C3=A9?= → "café"
      const message = makeMessage({ Subject: '=?UTF-8?Q?caf=C3=A9?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: café');
    });
  });

  it('decodes ISO-8859-1 Q-encoded subjects with the actual charset', async () => {
    await withSlug(async () => {
      // =?iso-8859-1?Q?J=FCrgen?= → "Jürgen"  (0xFC is 'ü' in Latin-1)
      // Decoding the same bytes as UTF-8 would mojibake to a replacement
      // char or a different glyph, so this test guards against the old
      // "always UTF-8" fallback path.
      const message = makeMessage({ Subject: '=?iso-8859-1?Q?J=FCrgen?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: Jürgen');
    });
  });

  it('does not double-prefix Re: when the encoded subject already starts with Re:', async () => {
    await withSlug(async () => {
      // base64('Re: hi') = "UmU6IGhp"
      const message = makeMessage({ Subject: '=?UTF-8?B?UmU6IGhp?=' });
      const built = await buildReplyMessage(message, { text: 'ack' });
      expect(built.subject).toBe('Re: hi');
    });
  });

  it('threads via In-Reply-To and starts a References chain', async () => {
    await withSlug(async () => {
      const message = makeMessage({
        Subject: 'Hi',
        'Message-ID': '<orig@example.com>',
      });
      const built = await buildReplyMessage(message, { text: 'ack' });
      const raw = new TextDecoder().decode(built.raw);
      expect(raw).toContain('In-Reply-To: <orig@example.com>');
      expect(raw).toContain('References: <orig@example.com>');
    });
  });

  it('appends to an existing References chain', async () => {
    await withSlug(async () => {
      const message = makeMessage({
        Subject: 'Hi',
        'Message-ID': '<msg2@example.com>',
        References: '<msg1@example.com>',
      });
      const built = await buildReplyMessage(message, { text: 'ack' });
      const raw = new TextDecoder().decode(built.raw);
      expect(raw).toContain('In-Reply-To: <msg2@example.com>');
      expect(raw).toContain('References: <msg1@example.com> <msg2@example.com>');
    });
  });

  it('honors explicit overrides', async () => {
    // No slug needed — explicit `from` skips the defaulting path.
    const message = makeMessage({ Subject: 'Hi' });
    const built = await buildReplyMessage(message, {
      from: 'override@app.dev',
      to: 'someone@else.dev',
      subject: 'Custom subject',
      text: 'ack',
    });
    expect(built.from).toBe('override@app.dev');
    expect(built.to).toBe('someone@else.dev');
    expect(built.subject).toBe('Custom subject');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: replicates what the worker entry codegen does at runtime.
// The codegen emits a `email(envelope)` method on a WorkerEntrypoint subclass
// that:
//   1. Builds a proxy via createMessageProxy(envelope)
//   2. Runs the dispatcher (which delegates to the matching user handler)
//   3. Returns getActions() to the platform router
// This test stitches the same pieces together and asserts the contract,
// without compiling and evaluating the actual generated code (which would
// need virtual:void-routes + cloudflare:workers).
// ---------------------------------------------------------------------------

describe('end-to-end: envelope → handler → action queue', () => {
  function makeEnvelope(overrides: Partial<EmailEnvelope> = {}): EmailEnvelope {
    const raw = new TextEncoder().encode(
      'From: sender@example.com\r\n' +
        'To: support+abc-1@app.dev\r\n' +
        'Subject: Help me\r\n' +
        'Message-ID: <orig@example.com>\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        'I have a problem\r\n',
    );
    return {
      from: 'sender@example.com',
      to: 'support+abc-1@app.dev',
      headers: { Subject: 'Help me', 'Message-ID': '<orig@example.com>' },
      raw,
      rawSize: raw.byteLength,
      ...overrides,
    };
  }

  // Mirrors the codegen pattern: build proxy, run handler, return actions.
  async function dispatchToHandler(
    envelope: EmailEnvelope,
    handler: (
      message: ForwardableEmailMessage,
      env: unknown,
      ctx: ExecutionContext,
      info?: { params: Record<string, string> },
    ) => void | Promise<void>,
    info: { params: Record<string, string> } = { params: {} },
  ) {
    const { message, getActions } = createMessageProxy(envelope);
    await handler(message, {}, {} as ExecutionContext, info);
    return getActions();
  }

  it('records a setReject action and returns it as the RPC result', async () => {
    const handler = defineEmail(async (message) => {
      message.setReject('not allowed');
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([{ type: 'reject', reason: 'not allowed' }]);
  });

  it('records a forward action with serialized headers', async () => {
    const handler = defineEmail(async (message) => {
      const fwd = new Headers({ 'X-Forwarded-By': 'void-test' });
      await message.forward('archive@example.com', fwd);
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([
      {
        type: 'forward',
        to: 'archive@example.com',
        headers: { 'x-forwarded-by': 'void-test' },
      },
    ]);
  });

  it('records a reply action with threaded MIME from replyEmail', async () => {
    // Explicit `from` — without __VOID_PROJECT_SLUG / __VOID_EMAIL_DOMAIN
    // in scope, replyEmail's defaulting path errors. Production threads both
    // from env; bare unit tests pass `from` explicitly to skip that machinery.
    const handler = defineEmail(async (message, _env, _ctx, info) => {
      const ticket = info?.params.ticket ?? 'unknown';
      await replyEmail(message, {
        from: 'support+abc-1@app.dev',
        text: `Got ticket ${ticket}`,
      });
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler, {
      params: { ticket: 'abc-1' },
    });
    expect(actions).toHaveLength(1);
    const reply = actions[0];
    if (reply.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(reply.from).toBe('support+abc-1@app.dev');
    expect(reply.to).toBe('sender@example.com');
    expect(reply.raw).toBeInstanceOf(Uint8Array);
    const rawText = new TextDecoder().decode(reply.raw);
    expect(rawText).toContain('Subject: Re: Help me');
    expect(rawText).toContain('In-Reply-To: <orig@example.com>');
    expect(rawText).toContain('References: <orig@example.com>');
    expect(rawText).toContain('Got ticket abc-1');
  });

  it('strips the platform <slug>+ prefix from message.to before user code sees it', async () => {
    // Production: every recipient arrives as `<slug>+<tag>@mail.void.cloud`.
    // The user-visible `message.to` should be the bare `<tag>@<domain>`,
    // matching the address shape user handlers wrote in `email/<addr>.ts`.
    let observedTo: string | undefined;
    let platformTo: string | undefined;
    const handler = defineEmail(async (message) => {
      observedTo = message.to;
      platformTo = (message as unknown as { __voidPlatformTo?: string }).__voidPlatformTo;
    });
    const envelope: EmailEnvelope = {
      from: 'sender@example.com',
      to: 'myslug+support@mail.void.cloud',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    };
    const { message, getActions } = createMessageProxy(envelope, { slug: 'myslug' });
    await handler(message, {}, {} as ExecutionContext, { params: {} });
    expect(getActions()).toEqual([]);
    expect(observedTo).toBe('support@mail.void.cloud');
    expect(platformTo).toBe('myslug+support@mail.void.cloud');
  });

  it('leaves message.to untouched when no slug is provided', async () => {
    // Unit-level safety net: slug-stripping is opt-in (the dispatcher
    // passes the slug explicitly). Without it, the proxy must not mangle
    // the address — local tests / harnesses without a known slug rely on
    // this for predictable behavior.
    let observedTo: string | undefined;
    const handler = defineEmail(async (message) => {
      observedTo = message.to;
    });
    const envelope: EmailEnvelope = {
      from: 'sender@example.com',
      to: 'myslug+support@mail.void.cloud',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    };
    const { message } = createMessageProxy(envelope);
    await handler(message, {}, {} as ExecutionContext, { params: {} });
    expect(observedTo).toBe('myslug+support@mail.void.cloud');
  });

  function replyTestMessage(): ForwardableEmailMessage {
    return {
      from: 'sender@example.com',
      to: 'support@mail.example.dev',
      headers: new Headers({ Subject: 'Hi' }),
      raw: new ReadableStream(),
      rawSize: 0,
    } as unknown as ForwardableEmailMessage;
  }

  it('replyEmail without from errors when __VOID_PROJECT_SLUG is unavailable', async () => {
    // After F2/F3 the default `from = message.to` path is gone — the
    // user-visible `message.to` is `<tag>@<domain>` (bare local-part)
    // which the platform's slug-pin would reject. Without an explicit
    // `from` and no __VOID_PROJECT_SLUG to default from, the call must
    // fail loudly rather than silently constructing an invalid envelope.
    await expect(
      envContext.run({ __VOID_EMAIL_DOMAIN: 'mail.staging.void.cloud' }, () =>
        replyEmail(replyTestMessage(), { text: 'ack' }),
      ),
    ).rejects.toThrow(/__VOID_PROJECT_SLUG/);
  });

  it('replyEmail without from errors when __VOID_EMAIL_DOMAIN is unavailable', async () => {
    // No silent fallback: with a slug but no configured mail domain the
    // reply must fail rather than being addressed from the production zone.
    await expect(
      envContext.run({ __VOID_PROJECT_SLUG: 'myslug' }, () =>
        replyEmail(replyTestMessage(), { text: 'ack' }),
      ),
    ).rejects.toThrow(/__VOID_EMAIL_DOMAIN/);
  });

  it('replyEmail keeps an explicit from with neither binding present', async () => {
    // The bindings only feed the default; an explicit sender is untouched.
    const built = await envContext.run({}, () =>
      buildReplyMessage(replyTestMessage(), { from: 'support@app.dev', text: 'ack' }),
    );
    expect(built.from).toBe('support@app.dev');
  });

  it('setReject is terminal: prior forwards are dropped and later forward/reply are no-ops', async () => {
    // CF treats setReject as terminal — once setReject fires, anything
    // queued before it never runs (router drops them) and anything called
    // after is silently discarded. The proxy mirrors that contract by
    // (a) walking back the action queue on setReject to remove preceding
    // forward/reply entries (with one warning describing how many were
    // dropped) and (b) warning + no-op for forward/reply called after.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = defineEmail(async (message) => {
        await message.forward('first@example.com');
        message.setReject('then reject');
        await message.forward('after-reject@example.com');
        await message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw: new TextEncoder().encode('Subject: late\r\n\r\nbody\r\n'),
          // The proxy's reply() accepts a duck-typed { from, to, raw },
          // but the ForwardableEmailMessage interface expects EmailMessage.
          // This cast keeps the runtime contract under test while
          // satisfying the public type.
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      });
      const actions = await dispatchToHandler(makeEnvelope(), handler);
      // Only the reject survives — the prior forward was walked back, the
      // later forward/reply are no-ops.
      expect(actions.map((a) => a.type)).toEqual(['reject']);
      // Three warnings: walk-back (prior forward), late forward, late reply.
      expect(warn).toHaveBeenCalledTimes(3);
      const warnMessages = warn.mock.calls.map((c) => String(c[0]));
      expect(warnMessages.some((m) => m.includes('1 forward/reply call'))).toBe(true);
      expect(warnMessages.some((m) => m.includes('forward()'))).toBe(true);
      expect(warnMessages.some((m) => m.includes('reply()'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('parseEmail can be called multiple times (cache replays)', async () => {
    // parseEmail caches the buffered raw bytes in a WeakMap keyed by the
    // proxy, so handlers can call it repeatedly without the underlying
    // ReadableStream being "already consumed". After parseEmail, accessing
    // message.raw still yields a usable ReadableStream (a fresh one per
    // access, backed by the cached bytes).
    let firstSubject: string | undefined;
    let secondSubject: string | undefined;
    let rawAfterParse: ReadableStream<Uint8Array> | undefined;
    const handler = defineEmail(async (message) => {
      const first = await parseEmail(message);
      firstSubject = first.subject;
      const second = await parseEmail(message);
      secondSubject = second.subject;
      rawAfterParse = message.raw;
    });
    await dispatchToHandler(makeEnvelope(), handler);
    expect(firstSubject).toBe('Help me');
    expect(secondSubject).toBe('Help me');
    // message.raw is a fresh ReadableStream each access, replayed from cache.
    expect(rawAfterParse).toBeInstanceOf(ReadableStream);
    const reader = rawAfterParse?.getReader();
    const chunks: Array<Uint8Array> = [];
    while (reader) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(total).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(
      chunks.reduce((acc, c) => {
        const merged = new Uint8Array(acc.byteLength + c.byteLength);
        merged.set(acc, 0);
        merged.set(c, acc.byteLength);
        return merged;
      }, new Uint8Array(0)),
    );
    expect(decoded).toContain('Subject: Help me');
  });

  it('returns an empty action queue when the handler does nothing', async () => {
    const handler = defineEmail(async () => {});
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([]);
  });
});
