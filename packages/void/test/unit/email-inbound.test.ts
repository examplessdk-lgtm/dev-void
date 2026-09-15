import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'pathslash';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { compileRouteTable } from '../../src/router/compile.ts';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import {
  compileEmailPattern,
  hasEmailHandlers,
  scanEmailHandlers,
  scanEmailHandlersSync,
} from '../../src/router/email.ts';
import * as emailBarrel from '../../src/runtime/email.ts';
import {
  buildReplyMessage,
  createMessageProxy,
  defineEmail,
  parseEmail,
  ParseEmailError,
  replyEmail,
  type EmailEnvelope,
} from '../../src/runtime/email/inbound.ts';
import { MAX_MESSAGE_BYTES, MimeError } from '../../src/runtime/email/mime.ts';
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

  it('rejects a second _default.<ext> file instead of letting glob order pick one', async () => {
    const root = setupRoot({
      'email/_default.ts': 'export default () => {}',
      'email/_default.js': 'export default () => {}',
    });
    // Glob order is readdir order, so either file may be reported as the
    // "second" one — the error must name both regardless.
    await expect(scanEmailHandlers(root)).rejects.toThrow(/is a second default handler next to/);
    await expect(scanEmailHandlers(root)).rejects.toThrow(/"_default\.ts"/);
    await expect(scanEmailHandlers(root)).rejects.toThrow(/"_default\.js"/);
    await expect(scanEmailHandlers(root)).rejects.toThrow(
      /keep exactly one email\/_default\.\* file/,
    );
    expect(() => scanEmailHandlersSync(root)).toThrow(/is a second default handler/);
  });

  it('matches _default exactly: _Default.ts and _default.test.ts are private helpers, not a collision', async () => {
    const root = setupRoot({
      'email/_default.mjs': 'export default () => {}',
      'email/_Default.ts': 'export default () => {}',
      'email/_default.test.ts': 'export default () => {}',
    });
    const scan = await scanEmailHandlers(root);
    expect(scan.defaultHandler).toBe('_default.mjs');
    expect(scan.addresses).toEqual([]);
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
): (message: unknown, env: unknown, ctx: unknown, opts?: { slug?: string }) => Promise<unknown> {
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

    await dispatch(message, {}, {}, { slug: 'acme' });

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

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('matches the full local part when the recipient carries no <slug>+ prefix', async () => {
    // Own-account delivery: Cloudflare hands the worker the address the
    // handler author wrote, with no platform slug in front of it. Nothing
    // was stripped, so nothing is stripped again — `support@` is `support`.
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(hits).toEqual(['support']);
  });

  it('keeps the tag of an unprefixed recipient: support+T-42@zone reaches support+[ticket]', async () => {
    // The flagship own-account case. The first `+` here belongs to the
    // TAG, not to a platform slug; stripping through it (the platform rule)
    // would leave `T-42`, which matches nothing, and the mail would land in
    // `_default`. Case is preserved in the captured param.
    const seen: Array<unknown> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => seen.push('static') },
      '/e/support+[ticket].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: unknown }) =>
          seen.push(info.params),
      },
      '/e/_default.ts': { default: () => seen.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'support+T-42@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(seen).toEqual([{ ticket: 'T-42' }]);
  });

  it('routes an unprefixed recipient nothing matches to _default', async () => {
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy({
      from: 'sender@example.com',
      to: 'billing@mail.acme.com',
      headers: {},
      raw: new Uint8Array(),
      rawSize: 0,
    });

    await dispatch(message, {}, {});

    expect(hits).toEqual(['default']);
  });

  it('still strips the platform prefix when a slug was removed and no tag follows', async () => {
    // `<slug>+@<domain>` with the slug injected: the prefix is recorded as
    // `__voidPlatformTo`, the tag after it is empty, and the empty string
    // must fall through to `_default` rather than match `support`.
    const hits: Array<string> = [];
    const dispatch = buildEmailDispatcher(compile({ ...SUPPORT, defaultHandler: '_default.ts' }), {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/_default.ts': { default: () => hits.push('default') },
    });

    const { message } = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme+@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    );

    await dispatch(message, {}, {}, { slug: 'acme' });

    expect(hits).toEqual(['default']);
  });

  it('reads a bare <slug>@<domain> on the platform as an EMPTY tag, never as the slug itself', async () => {
    // The platform router forwards a `+`-less recipient (the bare project address) with the
    // slug configured but nothing to strip, so `createMessageProxy` records no
    // `__voidPlatformTo`. Keyed on the marker, the dispatcher would match the full local part
    // and hand `email/[user].ts` `user = acme`; keyed on the configured slug, it is `_default`.
    const hits: Array<string> = [];
    const withDynamic = {
      addresses: [
        ...SUPPORT.addresses,
        {
          address: '[user]',
          filePath: '[user].ts',
          pattern: { kind: 'dynamic', regexSource: '^([^+@]+)$', paramNames: ['user'] },
        },
      ],
      defaultHandler: '_default.ts',
    };
    const modules = {
      '/e/support.ts': { default: () => hits.push('support') },
      '/e/support+[ticket].ts': { default: () => hits.push('ticket') },
      '/e/[user].ts': {
        default: (_m: unknown, _e: unknown, _c: unknown, info: { params: { user: string } }) =>
          hits.push(`user=${info.params.user}`),
      },
      '/e/_default.ts': { default: () => hits.push('default') },
    };
    const dispatch = buildEmailDispatcher(compile(withDynamic), modules);
    const bare = createMessageProxy(
      {
        from: 'sender@example.com',
        to: 'acme@mail.void.cloud',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      },
      { slug: 'acme' },
    ).message;
    expect((bare as { __voidPlatformTo?: string }).__voidPlatformTo).toBeUndefined();

    await dispatch(bare, {}, {}, { slug: 'acme' });
    expect(hits).toEqual(['default']);

    // And with no `_default`, the bare address is rejected rather than routed to `[user]`.
    const rejections: Array<string> = [];
    const strict = buildEmailDispatcher(
      compile({ ...withDynamic, defaultHandler: undefined }),
      modules,
    );
    (bare as { setReject: (reason: string) => void }).setReject = (reason) => {
      rejections.push(reason);
    };
    hits.length = 0;
    await strict(bare, {}, {}, { slug: 'acme' });
    expect(hits).toEqual([]);
    expect(rejections).toHaveLength(1);

    // Own account (no slug configured): `acme@` IS the local part, so `[user]` gets it.
    hits.length = 0;
    await dispatch(
      createMessageProxy({
        from: 'sender@example.com',
        to: 'acme@mail.acme.com',
        headers: {},
        raw: new Uint8Array(),
        rawSize: 0,
      }).message,
      {},
      {},
    );
    expect(hits).toEqual(['user=acme']);
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

    await dispatch(message, {}, {}, { slug: 'acme' });

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

describe('harness enforces the proxy action bounds, like production', () => {
  // The handler under test runs against production's own `createMessageProxy`
  // in both lanes (the generated `email()` entry builds it from the envelope),
  // and that proxy is where the queue cap, the address cap, the header-record
  // check and the reply bounds throw. A harness that recorded every call
  // instead passed a handler that fails on the 101st forward after deploy —
  // fourth divergence of this shape on this feature. These pin that the
  // harness throws the SAME error (class, code, message) at the same call.
  function harnessFor(handler: Parameters<typeof defineEmail>[0]) {
    return createInboundTestHarness({ routes: { _default: defineEmail(handler) } });
  }
  const DELIVERY = { from: 'u@x.dev', to: 'myslug+anything@app.dev' };

  it('throws the proxy error on the 101st queued action, and keeps the 100', async () => {
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      for (let i = 0; i < 100; i++) {
        await message.forward(`box${i}@example.com`);
      }
      try {
        await message.forward('overflow@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toBe(
      'email: handler queued more than 100 actions for one message.',
    );
    expect(harness.forwards).toHaveLength(100);
    expect(harness.forwards[99]).toEqual({ to: 'box99@example.com' });
  });

  it('fails the delivery with that error when the handler does not catch it', async () => {
    // Production enacts nothing from a handler that throws: the platform
    // router rejects the message as a handler error, and on your own account
    // the invocation fails before `enactEmailActions` runs.
    const harness = harnessFor(async (message) => {
      for (let i = 0; i <= 100; i++) {
        await message.forward(`box${i}@example.com`);
      }
    });
    await expect(harness.deliver(DELIVERY)).rejects.toThrow(/handler queued more than 100 actions/);
    expect(harness.forwards).toEqual([]);
    expect(harness.deliveries).toEqual([]);
  });

  it('refuses a forward address over the address-length limit', async () => {
    let thrown: unknown;
    const over = `${'a'.repeat(320)}@example.com`;
    const harness = harnessFor(async (message) => {
      try {
        await message.forward(over);
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('INVALID_TO');
    expect((thrown as MimeError).message).toBe(
      `to address is ${over.length} characters, over the 320-character limit.`,
    );
    expect(harness.forwards).toEqual([]);
  });

  it('refuses a forward address over the 254-octet path limit, by the sendEmail rule', async () => {
    // Under the 320 total above, so `forward()`'s own pre-check passes and
    // the refusal comes from `validateAddressParts` — the rule an outbound
    // `to` gets, inherited rather than mirrored.
    let thrown: unknown;
    const label = 'b'.repeat(63);
    const over = `a@${[label, label, label, label].join('.')}`;
    expect(over).toHaveLength(257);
    const harness = harnessFor(async (message) => {
      try {
        await message.forward(over);
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('INVALID_TO');
    expect((thrown as MimeError).message).toBe(
      'to: address is 257 octets, over the 254-octet limit in RFC 5321 §4.5.3.1.3.',
    );
    expect(harness.forwards).toEqual([]);
  });

  it('refuses a forward address carrying a control character, by the sendEmail rule', async () => {
    // The platform router's `isValidEmailAddress` refuses `\u0000-\u001f`
    // and `\u007f`, and used to be the first thing that did: `forward()`
    // recorded the address, the harness captured it as a success, and the
    // router dropped just that forward after earlier actions had fired.
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      try {
        await message.forward('a\x01b@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('INVALID_TO');
    expect((thrown as MimeError).message).toBe(
      'to: address contains a control character (U+0001).',
    );
    expect(harness.forwards).toEqual([]);
  });

  it('refuses a forward address carrying a colon, by the sendEmail rule', async () => {
    // Same class as the control character above: `:` is an RFC 5322
    // §3.2.3 special the platform router's `isValidEmailAddress` refuses,
    // and it was the one missing from the framework's address class —
    // `forward('a:b@example.com')` was recorded, the harness captured it as
    // a success, and the router dropped just that forward after the one
    // before it had fired.
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      await message.forward('first@example.com');
      try {
        await message.forward('a:b@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('INVALID_TO');
    expect((thrown as MimeError).message).toBe(
      "to: 'a:b@example.com' is not a valid email address.",
    );
    expect(harness.forwards).toEqual([{ to: 'first@example.com' }]);
  });

  it('refuses a forward header record with a CRLF in a value at the call, recording nothing for it', async () => {
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      await message.forward('first@example.com');
      try {
        await message.forward('archive@example.com', {
          'X-Trace': 'abc\r\nBcc: leak@evil.test',
        } as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      // A record that `new Headers()` accepts is recorded, and the capture
      // exposes it as the `Headers` its type declares.
      await message.forward('archive@example.com', {
        'X-Forwarded-By': 'void-test',
      } as unknown as Headers);
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toMatch(/^forward: invalid header/);
    expect(harness.forwards.map((f) => f.to)).toEqual(['first@example.com', 'archive@example.com']);
    expect(harness.forwards[0].headers).toBeUndefined();
    expect(harness.forwards[1].headers).toBeInstanceOf(Headers);
    expect(harness.forwards[1].headers?.get('X-Forwarded-By')).toBe('void-test');
  });

  it('refuses a malformed forward address at the call, recording nothing for it', async () => {
    // A harness that captured `Ops <ops@example.com>` as a forward passed a
    // handler whose deploy fails at native replay (Cloudflare) or loses the
    // forward at the router (platform). Same error as `sendEmail`'s `to`.
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      await message.forward('first@example.com');
      try {
        await message.forward('Ops <ops@example.com>');
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('INVALID_TO');
    expect((thrown as MimeError).message).toBe(
      "to: 'Ops <ops@example.com>' is not a valid email address.",
    );
    expect(harness.forwards).toEqual([{ to: 'first@example.com' }]);
  });

  it("refuses a forward header bag over the router's bounds at the call, recording nothing for it", async () => {
    // `new Headers()` accepts 33 headers, so the record-validity check
    // passes them, and the managed router drops the WHOLE action list on
    // the count (`forwardHeadersWithinBounds`). A harness that reported
    // this forward passed a handler whose managed deployment silently
    // performed no actions.
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      await message.forward('first@example.com');
      const bag = new Headers();
      for (let i = 0; i < 33; i++) {
        bag.set(`X-Void-${i}`, 'v');
      }
      try {
        await message.forward('archive@example.com', bag);
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toBe('forward: 33 headers, over the 32-header limit.');
    expect(harness.forwards).toEqual([{ to: 'first@example.com' }]);
  });

  it('reports the reject reason the router sends: sliced to 1000 and stripped of controls', async () => {
    // A reason built from the parsed message carries what the remote sender
    // put there — here a CRLF and a NUL smuggled through an RFC 2047
    // encoded-word, which `parseEmail` decodes. The managed router
    // normalizes the reason (`validateActions`) before it reaches the SMTP
    // reply; the harness must report that string, not the verbatim one a
    // native replay used to hand `setReject()`.
    const harness = harnessFor(async (message) => {
      const parsed = await parseEmail(message);
      message.setReject(`unwanted: ${parsed.subject}${'!'.repeat(2000)}`);
    });
    await harness.deliver({
      ...DELIVERY,
      raw:
        'From: u@x.dev\r\n' +
        'To: myslug+anything@app.dev\r\n' +
        'Subject: =?UTF-8?Q?spam=0D=0ABcc:_x=00?=\r\n' +
        '\r\n' +
        'body\r\n',
    });
    expect(harness.rejects).toHaveLength(1);
    // "unwanted: spam\r\nBcc: x\0" is 23 characters, so the 1000-character
    // window holds it plus 977 "!". The CRLF pair then collapses to ONE
    // space and the NUL to another, and the window is not refilled from
    // beyond the cut — 999 characters, the router's own trade.
    expect(harness.rejects[0]).toBe(`unwanted: spam Bcc: x ${'!'.repeat(977)}`);
    expect(harness.rejects[0]).toHaveLength(999);
  });

  it('reply() refuses a native EmailMessage with the proxy error', async () => {
    let thrown: unknown;
    const native = Object.freeze({ from: 'support@app.dev', to: 'u@x.dev' });
    const harness = harnessFor(async (message) => {
      try {
        await message.reply(native as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).code).toBe('MIME_ERROR');
    expect((thrown as MimeError).message).toMatch(/native EmailMessage cannot be replayed/);
    expect(harness.replies).toEqual([]);
  });

  it('reply() refuses a Uint8Array raw over MAX_MESSAGE_BYTES', async () => {
    let thrown: unknown;
    const harness = harnessFor(async (message) => {
      try {
        await message.reply({
          from: 'support@app.dev',
          to: 'u@x.dev',
          raw: new Uint8Array(MAX_MESSAGE_BYTES + 1),
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      } catch (e) {
        thrown = e;
      }
    });
    await harness.deliver(DELIVERY);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/exceeds Cloudflare limit/);
    expect(harness.replies).toEqual([]);
  });

  it('records nothing from a handler that throws, like production', async () => {
    const harness = harnessFor(async (message) => {
      await message.forward('ops@x.dev');
      throw new Error('boom');
    });
    await expect(harness.deliver(DELIVERY)).rejects.toThrow(/boom/);
    expect(harness.forwards).toEqual([]);
    expect(harness.deliveries).toEqual([]);
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

  it('`slug: null` matches the full local part, like a worker on your own Cloudflare account', async () => {
    // Own-account deploys carry no platform prefix: `support@mail.acme.com` reaches
    // `support`, and the first `+` belongs to the TAG. The default harness would read
    // `support` as a slug and land a plain `support@` in `_default`.
    const seen: Array<string> = [];
    const harness = createInboundTestHarness({
      slug: null,
      routes: {
        support: async () => {
          seen.push('support');
        },
        'support+[ticket]': async (_m, _e, _c, info) => {
          seen.push(`ticket=${info?.params.ticket}`);
        },
        _default: async () => {
          seen.push('default');
        },
      },
    });

    const plain = await harness.deliver({ from: 'u@x.dev', to: 'support@mail.acme.com' });
    expect(plain.handler).toBe('support');
    const tagged = await harness.deliver({ from: 'u@x.dev', to: 'support+T-42@mail.acme.com' });
    expect(tagged.handler).toBe('support+[ticket]');
    expect(tagged.params).toEqual({ ticket: 'T-42' });
    expect(seen).toEqual(['support', 'ticket=T-42']);
    // Nothing was stripped from what the handler sees either.
    const other = await harness.deliver({ from: 'u@x.dev', to: 'billing@mail.acme.com' });
    expect(other.handler).toBe('_default');
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

  it('survives a References chain with more tokens than Math.max takes arguments', async () => {
    // ~123k spread arguments is where V8 throws RangeError (measured on
    // workerd and node). 130k short ids is 780 KB, far inside
    // MAX_MESSAGE_BYTES, so a remote sender can reach it.
    const chain = Array.from({ length: 130_000 }, () => '<a@r>').join(' ');
    const message = inbound({ references: chain, 'message-id': '<abc@remote.dev>', subject: 'hi' });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    const text = new TextDecoder().decode(reply.raw);
    expect(text).toContain('In-Reply-To: <abc@remote.dev>');
    expect(Math.max(...text.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(998);
  });

  it('survives a Subject with more tokens than Math.max takes arguments', async () => {
    // The cheaper trigger: `prefixReplySubject` collapses whitespace runs, so
    // 130k single-character tokens is only 260 KB of ASCII.
    const subject = Array.from({ length: 130_000 }, () => 'a').join(' ');
    const message = inbound({ subject });

    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });

    const text = new TextDecoder().decode(reply.raw);
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

  // The line guard measures octets, the way the wire does, and the only
  // break it may count on is SP or HTAB — the whitespace `foldHeader` folds
  // at. The chain is carried when every id fits and dropped for the bare
  // message-id otherwise, and the answer must arrive in one pass with no
  // per-id allocation: a remote sender can put 10 MiB of ids in one header.
  const MESSAGE_ID = '<abc@remote.dev>';

  async function replyText(references: string, messageId = MESSAGE_ID): Promise<string> {
    const message = inbound({ references, 'message-id': messageId, subject: 'hi' });
    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
    return new TextDecoder().decode(reply.raw);
  }

  function widestLineOctets(text: string): number {
    const encoder = new TextEncoder();
    return text.split('\r\n').reduce((max, line) => Math.max(max, encoder.encode(line).length), 0);
  }

  it('keeps an id that exactly fills the line, and drops one octet more', async () => {
    // `References: ` is 12 octets, so 986 is the widest id one line carries.
    // With no Message-ID to append, the header is that one id, unfolded —
    // the only shape where the guard's budget is the wire line exactly. In a
    // chain every id is charged the same 12 octets although a folded
    // continuation costs 1, so the guard is conservative there, never loose.
    const atBudget = `<${'x'.repeat(984)}>`;
    const overBudget = `<${'x'.repeat(985)}>`;

    const kept = await replyText(atBudget, '');
    expect(kept).toContain(`References: ${atBudget}\r\n`);
    expect(widestLineOctets(kept)).toBe(998);

    const dropped = await replyText(overBudget, '');
    expect(dropped).not.toContain('References:');
    expect(widestLineOctets(dropped)).toBeLessThanOrEqual(998);
  });

  it('measures an id in UTF-8 octets, not UTF-16 units', async () => {
    // 495 units but 988 octets: a code-unit count would pass it.
    const id = `<${'é'.repeat(493)}>`;
    const text = await replyText(id);
    expect(text).not.toContain(id);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
    expect(widestLineOctets(text)).toBeLessThanOrEqual(998);
  });

  it('counts a surrogate pair as one four-octet code point', async () => {
    // A `Headers` value is a ByteString, so nothing above U+00FF arrives this
    // way in production; the count still has to agree with `TextEncoder`,
    // which is what `buildMime` measures the rendered line with.
    const id = `<${'😀'.repeat(247)}>`; // 496 units, 990 octets
    const headers = new Map([
      ['subject', 'hi'],
      ['message-id', MESSAGE_ID],
      ['references', id],
    ]);
    const message = {
      from: 'sender@remote.dev',
      to: 'support@app.dev',
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    } as unknown as ForwardableEmailMessage;
    const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
    const text = new TextDecoder().decode(reply.raw);
    expect(text).not.toContain(id);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
  });

  it('keeps a multibyte id that fits once encoded', async () => {
    const id = `<${'é'.repeat(492)}>`; // 494 units, 986 octets
    const text = await replyText(id, '');
    expect(text).toContain(`References: ${id}\r\n`);
    expect(widestLineOctets(text)).toBe(998);
  });

  it('does not count whitespace the folder cannot fold at as a break', async () => {
    // `\s` matches NBSP and FF, but RFC 5322 §3.2.2 folds only at SP/HTAB and
    // so does `foldHeader`. Splitting at either used to pass two fitting ids
    // that then landed on one 1222-octet line, and `buildMime` threw.
    const id = `<${'x'.repeat(600)}@remote.dev>`;
    for (const separator of [' ', '\f']) {
      const text = await replyText(`${id}${separator}${id}`);
      expect(text).not.toContain(id);
      expect(text).toContain(`References: ${MESSAGE_ID}`);
      expect(widestLineOctets(text)).toBeLessThanOrEqual(998);
    }
  });

  it('threads a chain at the raw cap’s scale, and every line still fits', async () => {
    // 9 MiB of two-character ids is 3.1M tokens. The reply carries its newest
    // 8 KiB, and the answer must not cost per token: a per-token allocation
    // here was 34 bytes each, which is the isolate.
    const chain = 'ab '.repeat((9 * 1024 * 1024) / 3).trimEnd();
    const text = await replyText(chain);
    expect(text).toContain(`In-Reply-To: ${MESSAGE_ID}`);
    expect(text).toContain('References: ab ab ab');
    expect(text).toContain(` ab ${MESSAGE_ID}`);
    expect(widestLineOctets(text)).toBeLessThanOrEqual(998);
  });

  it('answers for a 10 MiB chain in one pass', async () => {
    // The largest header a remote sender can deliver: MAX_MESSAGE_BYTES of
    // two-character ids (3.5M tokens), with one over-long id at the very end
    // so the whole chain is scanned before it is refused. `split(/\s+/)`
    // materialized 3.5M tokens first — measured at 570 ms and 147 MB, which
    // terminates a 128 MB isolate; the one-pass scan is 20 ms and 0 bytes.
    const chain = 'ab '.repeat(Math.floor(MAX_MESSAGE_BYTES / 3)) + `<${HUGE}@remote.dev>`;
    const started = performance.now();
    const text = await replyText(chain);
    const elapsed = performance.now() - started;
    expect(text).not.toContain(HUGE);
    expect(text).toContain(`References: ${MESSAGE_ID}`);
    // 34 ms here; a loaded 4-vCPU CI runner has measured 6x slower on this
    // file. The materializing form took 570 ms locally and would not fit a
    // 128 MB isolate at all — the memory is the real guard, the time a proxy.
    expect(elapsed).toBeLessThan(1000);
  });

  // The line guard bounds one id, not the chain: 10 MiB of short ids passes
  // it — every id folds — and the folded reply is then over
  // `MAX_MESSAGE_BYTES`, so `buildMime` threw instead of sending the reply the
  // guide promises, and the handler's earlier forwards went with it. A chain
  // is bounded at 8192 characters, checked on `length` alone, and past that
  // the reply keeps the NEWEST ids whole, the parent's id still last.
  const REFERENCES_BUDGET = 8192;

  /** The `References` value of a rendered reply, unfolded; `undefined` when absent. */
  function referencesOf(text: string): string | undefined {
    const headers = text.split('\r\n\r\n')[0].replace(/\r\n(?=[ \t])/g, '');
    return headers
      .split('\r\n')
      .find((line) => line.startsWith('References: '))
      ?.slice('References: '.length);
  }

  it('threads the newest ids of a chain over the budget, inside a 128 MB heap', () => {
    // The reviewer's shape: a `References` just under the inbound cap, of
    // short ids. Measured before the bound: 156 ms, 55 MB of heap, then
    // `MimeError: message size 10777129 bytes exceeds Cloudflare limit`.
    const inboundModule = pathToFileURL(
      join(import.meta.dirname, '../../src/runtime/email/inbound.ts'),
    ).href;
    const child = `
      const { buildReplyMessage, createMessageProxy } = await import(process.argv[1]);
      const references = '<a@b> '.repeat(Math.floor((${MAX_MESSAGE_BYTES} - 200) / 6)).trimEnd();
      const raw = new TextEncoder().encode('body');
      const { message } = createMessageProxy(
        {
          from: 'sender@remote.dev',
          to: 'acme+support@mail.void.cloud',
          headers: { references, 'message-id': ${JSON.stringify(MESSAGE_ID)}, subject: 'hi' },
          raw,
          rawSize: raw.length,
        },
        { slug: 'acme' },
      );
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const reply = await buildReplyMessage(message, { text: 'thanks', from: 'acme+noreply@x.dev' });
      const ms = performance.now() - t0;
      const heapDeltaMB = (process.memoryUsage().heapUsed - heap0) / (1024 * 1024);
      console.log(JSON.stringify({ text: new TextDecoder().decode(reply.raw), ms, heapDeltaMB }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', child, inboundModule],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      text: string;
      ms: number;
      heapDeltaMB: number;
    };
    expect(result.text).toContain(`In-Reply-To: ${MESSAGE_ID}`);
    const references = referencesOf(result.text);
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    expect(references!.startsWith('<a@b> ')).toBe(true);
    expect(references!.endsWith(` <a@b> ${MESSAGE_ID}`)).toBe(true);
    expect(widestLineOctets(result.text)).toBeLessThanOrEqual(998);
    // 4 ms and 0 MB measured; the bound leaves room for CI's slower runner.
    expect(result.ms).toBeLessThan(5000);
    expect(result.heapDeltaMB).toBeLessThan(16);
  }, 30_000);

  it('keeps the whole chain at the budget, and drops the oldest id one character over', async () => {
    // 900 eight-character ids and one 75-character first id: 8175 characters,
    // which with the parent's ` <abc@remote.dev>` is the budget exactly.
    const rest = Array.from({ length: 900 }, (_, i) => `<${String(i + 1).padStart(4, '0')}@r>`);
    const oldest = `<${'x'.repeat(71)}@r>`;
    const atBudget = [oldest, ...rest].join(' ');
    expect(atBudget.length + 1 + MESSAGE_ID.length).toBe(REFERENCES_BUDGET);

    const kept = referencesOf(await replyText(atBudget));
    expect(kept).toBe(`${atBudget} ${MESSAGE_ID}`);

    const trimmed = referencesOf(await replyText(`<x${oldest.slice(1)} ${rest.join(' ')}`));
    expect(trimmed).toBe(`${rest.join(' ')} ${MESSAGE_ID}`);
    expect(trimmed!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
  });

  it('never splits an id at the cut', async () => {
    // Long ids, so the character cut lands inside one: that id goes, whole,
    // and the tail starts on the next boundary.
    const ids = Array.from(
      { length: 200 },
      (_, i) => `<${String(i).padStart(3, '0')}${'y'.repeat(96)}@r>`,
    );
    const references = referencesOf(await replyText(ids.join(' ')));
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    const kept = references!.split(' ');
    expect(kept.at(-1)).toBe(MESSAGE_ID);
    for (const id of kept.slice(0, -1)) {
      expect(ids).toContain(id);
    }
    expect(kept.slice(0, -1)).toEqual(ids.slice(ids.length - (kept.length - 1)));
  });

  it('keeps the newest ids without a usable Message-ID', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `<${String(i).padStart(4, '0')}@r>`);
    const text = await replyText(ids.join(' '), '');
    expect(text).not.toContain('In-Reply-To:');
    const references = referencesOf(text);
    expect(references).toBeDefined();
    expect(references!.length).toBeLessThanOrEqual(REFERENCES_BUDGET);
    expect(references).not.toContain('<0000@r>');
    expect(references!.endsWith(' <0999@r>')).toBe(true);
  });

  it('threads the newest ids when the id no line can carry is an old one', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `<${String(i).padStart(4, '0')}@r>`);
    // Oldest: outside the tail, so the tail threads. Every id used to go.
    const oldestHuge = referencesOf(await replyText(`<${HUGE}@r> ${ids.join(' ')}`));
    expect(oldestHuge).not.toContain(HUGE);
    expect(oldestHuge!.endsWith(` <0999@r> ${MESSAGE_ID}`)).toBe(true);
    // Newest: inside the tail, so only the parent's id is threaded.
    const newestHuge = referencesOf(await replyText(`${ids.join(' ')} <${HUGE}@r>`));
    expect(newestHuge).toBe(MESSAGE_ID);
  });

  it('keeps the actions queued before a reply to a chain over the budget', async () => {
    // What the throw cost: `handleEmail` returns the queue only once the
    // handler resolves, so a forward recorded before the reply was lost with
    // it — bounced as a "project handler error" on the platform, never
    // enacted on a native message.
    const references = '<a@b> '.repeat(Math.floor((MAX_MESSAGE_BYTES - 200) / 6)).trimEnd();
    const raw = new TextEncoder().encode('Subject: hi\r\n\r\nbody\r\n');
    const { message, getActions } = createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { references, 'message-id': MESSAGE_ID, subject: 'hi' },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    );
    const handler = defineEmail(async (m) => {
      await m.forward('archive@acme.dev');
      await replyEmail(m, { text: 'thanks', from: 'acme+noreply@x.dev' });
    });

    await handler(message, {}, {} as ExecutionContext);

    const actions = getActions();
    expect(actions.map((a) => a.type)).toEqual(['forward', 'reply']);
    const reply = actions[1];
    if (reply.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(new TextDecoder().decode(reply.raw)).toContain(`In-Reply-To: ${MESSAGE_ID}`);
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

  it('decodes a subject of 750k encoded-words one word at a time', async () => {
    // MAX_MESSAGE_BYTES of `=?UTF-8?Q?a?=` is the largest subject a remote
    // sender can deliver. `replace` with a callback collected all 750k
    // matches before decoding the first — measured at 138 MB on the whole
    // reply path, which is the isolate; the lazy scan needs 35 MB. The
    // runner's heap is not capped, so this pins the behaviour: adjacent
    // encoded-words join, the decoded subject is one 750k-character ASCII
    // token no line can carry, and the reply falls back to a bare `Re:`.
    const subject = '=?UTF-8?Q?a?= '.repeat(Math.floor(MAX_MESSAGE_BYTES / 14));
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe('Re:');
  });

  // The other shape of the same header: ONE encoded-word carrying the whole
  // 10 MiB. The payload pattern accepts whitespace, so a folded `Subject`
  // arrives (unfolded by `Headers`) as a single Q-word and the decoder sees
  // every character of it. Pushing each byte onto an `Array<number>` first
  // measured 199 MB of heap for the decode alone and 330 MB peak on the reply
  // path — `FATAL ERROR: Reached heap limit` under `--max-old-space-size=128`,
  // which is the tenant isolate — before `buildMime`'s projection could
  // refuse the subject. Decoding into a preallocated `Uint8Array` peaks at
  // 10.5 MB on the same path (42 ms). The runner's own heap is not capped,
  // so the pin runs the reply in a child with the isolate's cap.
  it('replies to a 10 MiB single Q-encoded word inside a 128 MB heap', () => {
    const inboundModule = pathToFileURL(
      join(import.meta.dirname, '../../src/runtime/email/inbound.ts'),
    ).href;
    const child = `
      const { buildReplyMessage, createMessageProxy } = await import(process.argv[1]);
      const subject = '=?UTF-8?Q?' + 'a'.repeat(${MAX_MESSAGE_BYTES} - 20) + '?=';
      const raw = new TextEncoder().encode('body');
      const { message } = createMessageProxy(
        {
          from: 'sender@remote.dev',
          to: 'acme+support@mail.void.cloud',
          headers: { subject },
          raw,
          rawSize: raw.length,
        },
        { slug: 'acme' },
      );
      const t0 = performance.now();
      const reply = await buildReplyMessage(message, { text: 'thanks', from: ${JSON.stringify(FROM)} });
      console.log(JSON.stringify({ subject: reply.subject, ms: performance.now() - t0 }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', child, inboundModule],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      subject: string;
      ms: number;
    };
    // The decoded word is one 10 MiB ASCII token no line can carry, so the
    // subject falls back — the same answer the 750k-word shape gets.
    expect(result.subject).toBe('Re:');
    // 42 ms measured locally; the bound leaves room for CI's slower runner
    // (about 6x), where the old `Array<number>` shape did not finish at all.
    expect(result.ms).toBeLessThan(5000);
  }, 30_000);

  // A folded `Subject` reaches the decoder unfolded: `Headers` — Cloudflare's
  // `ForwardableEmailMessage.headers` and the proxy's `new Headers(envelope
  // .headers)` alike — rejects CR and LF, so what the payload can carry from a
  // fold is the SP / HTAB that followed the CRLF. That whitespace is a literal
  // byte to the Q decoder, and `prefixReplySubject` folds the run into the
  // single space `_` would have produced.
  it('decodes a Q-word carrying unfolded FWS to the same subject as the unfolded word', async () => {
    const unfolded = await buildReplyMessage(inbound('=?UTF-8?Q?good=20sub_ject?='), {
      text: 'thanks',
      from: FROM,
    });
    const folded = await buildReplyMessage(inbound('=?UTF-8?Q?good=20sub\t ject?='), {
      text: 'thanks',
      from: FROM,
    });
    expect(unfolded.subject).toBe('Re: good sub ject');
    expect(folded.subject).toBe(unfolded.subject);
  });

  it.each([
    ['a lone = at the end', '=?UTF-8?Q?a=?=', 'Re: a='],
    ['a one-digit escape at the end', '=?UTF-8?Q?a=4?=', 'Re: a=4'],
    ['a well-formed escape at the end', '=?UTF-8?Q?a=41?=', 'Re: aA'],
    ['a malformed second digit', '=?UTF-8?Q?a=4G?=', 'Re: a=4G'],
    ['an escape that is the whole payload', '=?UTF-8?Q?=41?=', 'Re: A'],
  ])('keeps the Q escape rules at the payload edge for %s', async (_label, subject, expected) => {
    const reply = await buildReplyMessage(inbound(subject), { text: 'thanks', from: FROM });
    expect(reply.subject).toBe(expected);
  });

  /**
   * Build the reply in a child Node under the tenant isolate's 128 MB heap
   * cap and report what it cost there. `subjectSource` is a JS expression
   * evaluated in the child, so the fixture is built inside the cap too.
   */
  function replyInIsolate(subjectSource: string): {
    subject: string;
    ms: number;
    heapDeltaMB: number;
  } {
    const inboundModule = pathToFileURL(
      join(import.meta.dirname, '../../src/runtime/email/inbound.ts'),
    ).href;
    const child = `
      const { buildReplyMessage, createMessageProxy } = await import(process.argv[1]);
      const subject = ${subjectSource};
      const raw = new TextEncoder().encode('body');
      const { message } = createMessageProxy(
        {
          from: 'sender@remote.dev',
          to: 'acme+support@mail.void.cloud',
          headers: { subject },
          raw,
          rawSize: raw.length,
        },
        { slug: 'acme' },
      );
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const reply = await buildReplyMessage(message, { text: 'thanks', from: ${JSON.stringify(FROM)} });
      const ms = performance.now() - t0;
      const heapDeltaMB = (process.memoryUsage().heapUsed - heap0) / (1024 * 1024);
      console.log(JSON.stringify({ subject: reply.subject, ms, heapDeltaMB }));
    `;
    const stdout = execFileSync(
      process.execPath,
      ['--max-old-space-size=128', '--input-type=module', '-e', child, inboundModule],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      subject: string;
      ms: number;
      heapDeltaMB: number;
    };
  }

  // The third shape of the same header, aimed past the decoder at the
  // control-character replacements: a global `replace` materializes one
  // part per match before it builds the result, about 66 bytes each, so
  // 5 MiB of alternating tab and letter (2.6M matches, inside
  // MAX_MESSAGE_BYTES, no encoded-word for the decoder to touch) measured
  // 165 MB on the first replacement alone, 191 MB and 206 ms on the reply
  // path, and terminated a 128 MB isolate. The decoded subject is now
  // bounded BEFORE the replacements run — 2.3 ms and 0.5 MB on the same
  // path — so the pin runs in a child with the isolate's cap, where the
  // old shape did not finish at all.
  it('replies to a 5 MiB subject of alternating tabs and letters inside a 128 MB heap', () => {
    const result = replyInIsolate(`'\\ta'.repeat(${(5 * 1024 * 1024) / 2})`);
    expect(result.subject).toBe('Re:');
    expect(result.ms).toBeLessThan(200);
    expect(result.heapDeltaMB).toBeLessThan(64);
  }, 30_000);

  // The bound sits on the decoded subject and is checked before the
  // replacements: a subject exactly at it is still repaired, one character
  // over falls back. `\x01` rather than a tab, because `Headers` strips
  // leading and trailing HTTP whitespace and the count must be exact.
  it('repairs a subject exactly at the bound and falls back one character over', async () => {
    const atBound = 'a\x01'.repeat(2048); // 4096 code units
    const kept = await buildReplyMessage(inbound(atBound), { text: 'thanks', from: FROM });
    expect(kept.subject).toBe(`Re: ${'a '.repeat(2048).trim()}`);
    expect(maxLine(kept)).toBeLessThanOrEqual(998);

    const over = await buildReplyMessage(inbound(`${atBound}a`), { text: 'thanks', from: FROM });
    expect(over.subject).toBe('Re:');
  });

  // It is the DECODED length that is bounded. B-encoded, 4096 three-octet
  // characters arrive as a 19,945-character header, so a bound on the raw
  // header would have refused a CJK subject a quarter that long. The
  // rendered `Subject` line of that subject is the widest any kept subject
  // renders to — about 20 KB, against a 10 MiB message limit.
  it('bounds the decoded subject, not the encoded header it arrived in', async () => {
    // Fifteen three-octet characters fill a 45-octet encoded-word exactly,
    // so no character is split across words (RFC 2047 §5).
    const encode = (text: string) => {
      const words: Array<string> = [];
      for (let i = 0; i < text.length; i += 15) {
        const bytes = new TextEncoder().encode(text.slice(i, i + 15));
        words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`);
      }
      return words.join(' ');
    };
    const atBound = '日'.repeat(4096);
    const header = encode(atBound);
    expect(header.length).toBeGreaterThan(4 * atBound.length);

    const kept = await buildReplyMessage(inbound(header), { text: 'thanks', from: FROM });
    expect(kept.subject).toBe(`Re: ${atBound}`);
    expect(maxLine(kept)).toBeLessThanOrEqual(998);
    expect(kept.raw.byteLength).toBeLessThan(32 * 1024);

    const over = await buildReplyMessage(inbound(encode(`${atBound}日`)), {
      text: 'thanks',
      from: FROM,
    });
    expect(over.subject).toBe('Re:');
  });

  // The residual the previous round left open. A 10 MiB subject WITH spaces
  // folds — every token is one character — so `fitsHeaderLine` passed it,
  // `buildMime`'s projection (a lower bound) passed it, and the folded
  // `Subject` alone rendered to 10,761,941 octets: the final size check
  // threw `MimeError` out of `replyEmail()`, the throw this path exists to
  // prevent. Bounded, the subject falls back and the reply is recorded.
  it('replies to a 10 MiB subject that folds instead of throwing MimeError from the size check', async () => {
    const raw = new TextEncoder().encode('body');
    const { message, getActions } = createMessageProxy(
      {
        from: 'sender@remote.dev',
        to: 'acme+support@mail.void.cloud',
        headers: { subject: 'a '.repeat(MAX_MESSAGE_BYTES / 2) },
        raw,
        rawSize: raw.length,
      },
      { slug: 'acme' },
    );

    await replyEmail(message, { text: 'thanks', from: FROM });

    const [action] = getActions();
    if (action?.type !== 'reply') {
      throw new Error('expected reply action');
    }
    expect(new TextDecoder().decode(action.raw)).toContain('Subject: Re:\r\n');
  });
});

describe('parseEmail error contract', () => {
  // `PARSE_FAILED` was declared in the code union but never constructed, so
  // the one thing that does make postal-mime reject — a deeply nested
  // message — escaped as a bare Error carrying parser internals. The union
  // has to be honest: every code it names is reachable.
  it('wraps a raw-stream read failure as PARSE_FAILED', async () => {
    // An own-account delivery wraps Cloudflare's native one-shot `raw` with
    // `createMessageProxy`, so the buffering read is what fails. The
    // acquisition used to sit above the guarded block, and the stream error
    // escaped raw.
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream broke mid-delivery'));
      },
    });
    const { message } = createMessageProxy(
      { from: 'a@b.dev', to: 'acme+x@mail.void.cloud', headers: {}, raw, rawSize: 32 },
      { slug: 'acme' },
    );

    await expect(parseEmail(message)).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseEmailError && e.code === 'PARSE_FAILED',
    );
  });

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

describe('void/email barrel exports the error classes it throws', () => {
  // `package.json` exposes only `./email` and `./email/testing` — there is no
  // wildcard subpath — so a class a handler author cannot reach through the
  // barrel is a class they cannot `instanceof` at all, however well it is
  // documented. The barrel exports two throwing entrypoints (`parseEmail`,
  // `createEmail`); both error classes have to come with them.
  it('re-exports ParseEmailError as the same class parseEmail throws', async () => {
    expect(emailBarrel.ParseEmailError).toBe(ParseEmailError);

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
      (e: unknown) => e instanceof emailBarrel.ParseEmailError && e.code === 'INBOUND_TOO_LARGE',
    );
  });

  it('re-exports MimeError as the same class createEmail throws', () => {
    expect(emailBarrel.MimeError).toBe(MimeError);
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

  it('throws rather than falling back to message.to when the slug cannot be a sender', async () => {
    // A slug over 56 characters cannot build `<slug>+noreply@`, which must
    // stay inside RFC 5321's 64-octet local part. Falling through to
    // `message.to` builds the slug-stripped shape the platform reply pin
    // drops, so the handler would see a success and the mail would vanish.
    await envContext.run(
      { __VOID_PROJECT_SLUG: 'a'.repeat(57), __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
      async () => {
        const message = makeMessage({ Subject: 'Help me' });
        await expect(buildReplyMessage(message, { text: 'sure' })).rejects.toThrow(
          /cannot build a default reply sender/,
        );
      },
    );
  });

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

  it('replyEmail without from replies from message.to when there is no __VOID_PROJECT_SLUG', async () => {
    // No slug means no platform slug-pin to satisfy: the message reached a
    // real address on the developer's own zone, and that address is the
    // reply sender. A domain binding on its own does not change that.
    const built = await envContext.run({ __VOID_EMAIL_DOMAIN: 'mail.staging.void.cloud' }, () =>
      buildReplyMessage(replyTestMessage(), { text: 'ack' }),
    );
    expect(built.from).toBe('support@mail.example.dev');
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

  it('reply() refuses a native EmailMessage with a named error', async () => {
    // What workerd's `EmailMessage` looks like to JS: `from` and `to` only —
    // workers-types declares nothing else and the body has no accessor, so
    // the proxy cannot record it as bytes. It used to die on
    // `undefined.getReader()`, since the first commit of this file.
    const native = Object.freeze({ from: 'support@app.dev', to: 'sender@example.com' });
    const handler = defineEmail(async (message) => {
      await message.reply(native as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    const failure = dispatchToHandler(makeEnvelope(), handler);
    await expect(failure).rejects.toBeInstanceOf(MimeError);
    await expect(failure).rejects.toThrow(/native EmailMessage cannot be replayed/);
    await expect(failure).rejects.toThrow(/replyEmail\(\)/);
  });

  it('reply() rejects a Uint8Array raw over MAX_MESSAGE_BYTES', async () => {
    const handler = defineEmail(async (message) => {
      await message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw: new Uint8Array(MAX_MESSAGE_BYTES + 1),
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toThrow(
      /exceeds Cloudflare limit/,
    );
  });

  it('reply() stops reading a stream raw once MAX_MESSAGE_BYTES is exceeded', async () => {
    // A stream that never closes: without the bound, reply() would buffer forever.
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const raw = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const handler = defineEmail(async (message) => {
      await message.reply({
        from: 'support@app.dev',
        to: 'sender@example.com',
        raw,
      } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toThrow(
      /exceeds Cloudflare limit/,
    );
    expect(cancelled).toBe(true);
    // 10 MiB limit + the chunk that crosses it + the stream's own read-ahead.
    expect(pulls).toBeLessThanOrEqual(12);
  });

  it('refuses the 101st queued action and leaves the queue at 100', async () => {
    // The queue crosses the RPC boundary into the SHARED proxy isolate, where
    // it is walked entry by entry before any quota gate has looked at it.
    // The router enforces the same 100; this is the fast, precise failure.
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      for (let i = 0; i < 100; i++) {
        await message.forward(`box${i}@example.com`);
      }
      try {
        await message.forward('overflow@example.com');
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toHaveLength(100);
    expect(actions.every((a) => a.type === 'forward')).toBe(true);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/more than 100 actions/);
  });

  it('refuses a third reply once the cumulative reply budget is spent', async () => {
    // This is what the per-reply cap does NOT catch: each of the first two
    // replies is exactly at MAX_MESSAGE_BYTES and legal on its own, and the
    // third is a single byte — but 2 x MAX_MESSAGE_BYTES is the whole budget
    // for one delivery, so the byte is refused.
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      const send = (raw: Uint8Array) =>
        message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw,
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      await send(new Uint8Array(MAX_MESSAGE_BYTES));
      await send(new Uint8Array(MAX_MESSAGE_BYTES));
      try {
        await send(new Uint8Array(1));
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    // Both full-size replies are legal and queued; only the third is refused.
    expect(actions).toHaveLength(2);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/cumulative reply size/);
  });

  it('cancels a stream reply at the REMAINING budget, not the per-reply cap', async () => {
    // 15 MiB already spent out of the 20 MiB budget, so 5 MiB is left. A
    // stream bounded by the per-reply cap would keep pulling to 10 MiB and
    // report the wrong limit; the pull count and the message both pin that
    // the remaining budget is what stopped it.
    //
    // Two prior replies, not one: after a single full-size reply the
    // remaining budget is exactly MAX_MESSAGE_BYTES, which cannot be told
    // apart from the per-reply cap.
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const raw = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    let thrown: unknown;
    const handler = defineEmail(async (message) => {
      const send = (body: Uint8Array | ReadableStream<Uint8Array>) =>
        message.reply({
          from: 'support@app.dev',
          to: 'sender@example.com',
          raw: body,
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      await send(new Uint8Array(MAX_MESSAGE_BYTES));
      await send(new Uint8Array(5 * 1024 * 1024));
      try {
        await send(raw);
      } catch (e) {
        thrown = e;
      }
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toHaveLength(2);
    expect(cancelled).toBe(true);
    // 5 MiB of remaining budget + the chunk that crosses it + read-ahead —
    // NOT the ~11 a 10 MiB per-reply cap would have allowed.
    expect(pulls).toBeLessThanOrEqual(7);
    expect(thrown).toBeInstanceOf(MimeError);
    expect((thrown as MimeError).message).toMatch(/cumulative reply size/);
  });

  it('refuses a forward address over the address-length limit', async () => {
    const handler = defineEmail(async (message) => {
      await message.forward(`${'a'.repeat(320)}@example.com`);
    });
    await expect(dispatchToHandler(makeEnvelope(), handler)).rejects.toThrow(
      /over the 320-character limit/,
    );
  });

  it('records a plain header record verbatim, keeping the name casing', async () => {
    const handler = defineEmail(async (message) => {
      // The record form is a runtime affordance (JS handlers, or a cast):
      // `ForwardableEmailMessage.forward` is typed against `Headers`.
      const record = { 'X-Forwarded-By': 'void-test' } as unknown as Headers;
      await message.forward('archive@example.com', record);
    });
    const actions = await dispatchToHandler(makeEnvelope(), handler);
    expect(actions).toEqual([
      { type: 'forward', to: 'archive@example.com', headers: { 'X-Forwarded-By': 'void-test' } },
    ]);
  });

  it.each([
    ['a CRLF in a value', { 'X-Trace': 'abc\r\nBcc: leak@evil.test' }],
    ['a NUL in a value', { 'X-Trace': 'abc\0' }],
    ['a non-token name', { 'X Trace': 'abc' }],
  ])(
    'refuses a forward header record with %s at the call, recording nothing for it',
    async (_label, headers) => {
      // The record is replayed through `new Headers()` (natively and in the
      // platform router). What that constructor rejects must fail here, in
      // the handler, not after earlier actions have already fired.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward('archive@example.com', headers as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('MIME_ERROR');
      expect((thrown as MimeError).message).toMatch(/^forward: invalid header/);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  function headerBag(count: number): Record<string, string> {
    const bag: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      bag[`X-Void-${i}`] = 'v';
    }
    return bag;
  }

  it.each([
    ['33 headers in a record', headerBag(33), 'forward: 33 headers, over the 32-header limit.'],
    [
      '33 headers in a Headers',
      new Headers(headerBag(33)),
      'forward: 33 headers, over the 32-header limit.',
    ],
    [
      'a 1025-character name',
      { ['X'.repeat(1025)]: 'v' },
      'forward: header name is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a 1025-character value in a record',
      { 'X-Void-Tag': 'v'.repeat(1025) },
      'forward: header "X-Void-Tag" value is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a 1025-character value in a Headers',
      new Headers({ 'X-Void-Tag': 'v'.repeat(1025) }),
      'forward: header "x-void-tag" value is 1025 characters, over the 1024-character limit.',
    ],
    [
      'a non-string value',
      { 'X-Void-Tag': 123 },
      'forward: header "X-Void-Tag" value is not a string.',
    ],
  ])(
    'refuses a forward header bag with %s at the call, recording nothing for it',
    async (_label, headers, expected) => {
      // `new Headers()` accepts every one of these, so the validity check
      // above passes them. The platform router then applies its own count
      // and per-field bounds (`forwardHeadersWithinBounds`) and drops the
      // WHOLE action list — a handler that recorded this forward deployed as
      // one whose managed delivery silently performed no actions. The same
      // bounds, on the record about to be stored, fail the handler's call.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward('archive@example.com', headers as unknown as Headers);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('MIME_ERROR');
      expect((thrown as MimeError).message).toBe(expected);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  it("records a forward header bag exactly at the router's bounds", async () => {
    // 32 headers, every name and value 1024 characters: the largest bag the
    // managed router enacts. The bound is `>` on both sides, not `>=`.
    const bag: Record<string, string> = {};
    for (let i = 0; i < 32; i++) {
      bag[`X-${'a'.repeat(1020)}${String(i).padStart(2, '0')}`] = 'v'.repeat(1024);
    }
    const { message, getActions } = createMessageProxy(makeEnvelope());
    await message.forward('archive@example.com', bag as unknown as Headers);
    const actions = getActions();
    expect(actions).toHaveLength(1);
    const recorded = (actions[0] as { headers?: Record<string, string> }).headers ?? {};
    expect(Object.keys(recorded)).toHaveLength(32);
    for (const [name, value] of Object.entries(recorded)) {
      expect(name).toHaveLength(1024);
      expect(value).toHaveLength(1024);
    }
  });

  it('normalizes the reject reason as the router does: slice to 1000, then strip controls', () => {
    // The router's own fixture (`email-router.test.ts`): 300 x "line\r\n" is
    // 1800 characters; the first 1000 code units are 166 full lines plus
    // "line", and each CRLF then becomes one space — 834 characters, not
    // 1000. Recorded this way, the native replay hands `setReject()` the
    // string the platform router would, and a harness reports it.
    const { message, getActions } = createMessageProxy(makeEnvelope());
    message.setReject('line\r\n'.repeat(300));
    expect(getActions()).toEqual([{ type: 'reject', reason: 'line '.repeat(166) + 'line' }]);
  });

  it('bounds a multi-megabyte control-laden reject reason before it is recorded', () => {
    // A reason built from the inbound message can be as large as the message
    // and carry a remote sender's CRLF; both used to be recorded verbatim and,
    // on your own account, replayed verbatim into the SMTP reply.
    const { message, getActions } = createMessageProxy(makeEnvelope());
    message.setReject(`${'x'.repeat(5 * 1024 * 1024)}\r\n\x00`);
    const [action] = getActions();
    expect(action).toEqual({ type: 'reject', reason: 'x'.repeat(1000) });
  });

  it("records the router's substitute for an empty reason, and a space for a controls-only one", () => {
    // The router checks for empty BEFORE it strips (`validateActions`), so a
    // reason that is only controls becomes one space, not the substitute.
    const empty = createMessageProxy(makeEnvelope());
    empty.message.setReject('');
    expect(empty.getActions()).toEqual([{ type: 'reject', reason: 'rejected by handler' }]);
    const controls = createMessageProxy(makeEnvelope());
    controls.message.setReject('\r\n');
    expect(controls.getActions()).toEqual([{ type: 'reject', reason: ' ' }]);
  });

  it.each([
    ['no @', 'not-an-address', "to: 'not-an-address' is not a valid email address."],
    // `forward(rcptTo)` takes a bare address — Cloudflare's "verified
    // destination address" — so the display-name form `sendEmail` parses
    // is not an address here.
    [
      'a display name',
      'Ops <ops@example.com>',
      "to: 'Ops <ops@example.com>' is not a valid email address.",
    ],
    ['two @', 'a@b@example.com', "to: 'a@b@example.com' is not a valid email address."],
    ['an empty domain', 'user@', "to: 'user@' is not a valid email address."],
    ['an empty local part', '@example.com', "to: '@example.com' is not a valid email address."],
    [
      'a list separator',
      'a@example.com,b@example.com',
      "to: 'a@example.com,b@example.com' is not a valid email address.",
    ],
    ['whitespace', 'a b@example.com', "to: 'a b@example.com' is not a valid email address."],
    [
      'a 65-octet local part',
      `${'a'.repeat(65)}@example.com`,
      'to: local part is 65 octets, over the 64-octet limit in RFC 5321 §4.5.3.1.1.',
    ],
  ])(
    'refuses a forward address with %s at the call, recording nothing for it',
    async (_label, to, expected) => {
      // Same class as the header record above, for the address: Cloudflare
      // refuses it at native replay, the platform router before enaction.
      // Checked here with the rule `sendEmail` applies to its `to`, so a
      // handler's forward refuses exactly what an outbound send refuses.
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.forward(to);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe('INVALID_TO');
      expect((thrown as MimeError).message).toBe(expected);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    },
  );

  it('refuses a hand-built reply with a malformed address at the call, recording nothing for it', async () => {
    // The `{ from, to, raw }` reply form bypasses `normalizeEmail`, so it
    // gets the same record-time rule as `forward(to)`: a bad address fails
    // in the handler's own call, before any native replay could fire the
    // actions queued ahead of it.
    const cases: Array<[Record<'from' | 'to', string>, 'INVALID_FROM' | 'INVALID_TO', string]> = [
      [
        { from: 'not-an-address', to: 'ops@example.com' },
        'INVALID_FROM',
        "from: 'not-an-address' is not a valid email address.",
      ],
      [
        { from: 'me@example.com', to: 'Ops <ops@example.com>' },
        'INVALID_TO',
        "to: 'Ops <ops@example.com>' is not a valid email address.",
      ],
      [
        { from: `${'a'.repeat(65)}@example.com`, to: 'ops@example.com' },
        'INVALID_FROM',
        'from: local part is 65 octets, over the 64-octet limit in RFC 5321 §4.5.3.1.1.',
      ],
    ];
    for (const [addrs, code, expected] of cases) {
      const { message, getActions } = createMessageProxy(makeEnvelope());
      await message.forward('first@example.com');
      let thrown: unknown;
      try {
        await message.reply({
          ...addrs,
          raw: new TextEncoder().encode('Subject: x\r\n\r\nhi'),
        } as unknown as Parameters<ForwardableEmailMessage['reply']>[0]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MimeError);
      expect((thrown as MimeError).code).toBe(code);
      expect((thrown as MimeError).message).toBe(expected);
      expect(getActions()).toEqual([{ type: 'forward', to: 'first@example.com' }]);
    }
  });

  it('records every forward address sendEmail would accept', async () => {
    // Not the platform router's `isValidEmailAddress`, which also wants a
    // dot in the domain: `user@localhost` is legal RFC 5321 and is what the
    // outbound path accepts. A dot-less domain still reaches the router,
    // which drops that one forward on its own. A local part of exactly 64
    // octets, a `+` tag and a non-ASCII local part (SMTPUTF8) are all fine.
    const accepted = [
      'user@localhost',
      'x@y',
      'ops+T-42@example.com',
      `${'a'.repeat(64)}@example.com`,
      'jöhn@example.com',
    ];
    const { message, getActions } = createMessageProxy(makeEnvelope());
    for (const to of accepted) {
      await message.forward(to);
    }
    expect(getActions()).toEqual(accepted.map((to) => ({ type: 'forward', to })));
  });

  it('setReject still works with a full queue (it shrinks the queue, so it is exempt)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = defineEmail(async (message) => {
        for (let i = 0; i < 100; i++) {
          await message.forward(`box${i}@example.com`);
        }
        // The queue is at MAX_ACTIONS; setReject must not throw here — it
        // purges the 100 forwards and leaves one reject behind.
        message.setReject('not allowed');
      });
      const actions = await dispatchToHandler(makeEnvelope(), handler);
      expect(actions).toEqual([{ type: 'reject', reason: 'not allowed' }]);
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
