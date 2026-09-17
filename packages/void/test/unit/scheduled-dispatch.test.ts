import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'pathslash';
import { afterEach, expect, it } from 'vite-plus/test';
import { generateWrapper } from '../../src/cli/wrapper.ts';
import { compileRouteTable } from '../../src/router/compile.ts';

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const jobs = [
  { name: 'first', filePath: 'first.mjs', crons: ['* * * * *', '* * * * *'] },
  { name: 'second', filePath: 'second.mjs', crons: ['* * * * *'] },
  { name: 'other', filePath: 'other.mjs', crons: ['0 1 * * *'] },
];
type JobEnv = { calls: Array<string>; fail: boolean };

it('authenticates framework cron HTTP requests while leaving native events usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cron-auth-'));
  roots.push(root);
  mkdirSync(join(root, 'crons'));
  writeFileSync(
    join(root, 'index.mjs'),
    'export default { fetch() { return new Response("app"); } };',
  );
  writeFileSync(
    join(root, 'crons/job.mjs'),
    'export default (_controller, env) => { env.calls.push("ran"); };',
  );
  await generateWrapper(root, 'index.mjs', root, {
    auth: null,
    queues: [],
    crons: [{ name: 'job', filePath: 'job.mjs', crons: ['* * * * *'] }],
  });
  const worker = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default;
  const request = (token?: string) =>
    new Request('https://public.example/__void/scheduled', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-void-internal': token } : {}),
      },
      body: JSON.stringify({ cron: '* * * * *', scheduledTime: 1 }),
    });
  const calls: Array<string> = [];
  for (const [bindings, token] of [
    [{}, undefined],
    [{}, 'attacker'],
    [{ CRON_SECRET: '' }, undefined],
    [{ CRON_SECRET: 'secret' }, undefined],
    [{ CRON_SECRET: 'secret' }, 'wrong'],
    [{ __VOID_PROXY_TOKEN: 'proxy', CRON_SECRET: 'secret' }, 'secret'],
  ] as const) {
    expect((await worker.fetch(request(token), { ...bindings, calls }, {})).status).toBe(401);
  }
  expect(calls).toEqual([]);
  await worker.scheduled({ cron: '* * * * *', scheduledTime: 1 }, { calls }, {});
  expect(calls).toEqual(['ran']);
  for (const [bindings, token] of [
    [{ CRON_SECRET: 'secret' }, 'secret'],
    [{ __VOID_PROXY_TOKEN: 'proxy' }, 'proxy'],
  ] as const) {
    expect((await worker.fetch(request(token), { ...bindings, calls }, {})).status).toBe(200);
  }
  expect(calls).toHaveLength(3);
});

it.each(['native', 'framework'])(
  '%s executes every matching job once and waits for siblings after failure',
  async (kind) => {
    let scheduled: (controller: { cron: string }, env: JobEnv, ctx: object) => Promise<void>;
    if (kind === 'native') {
      const code = compileRouteTable(
        {
          routes: [],
          middleware: [],
          jobs,
          queues: [],
          pages: { pages: [], layouts: [], namedLayouts: [] },
        },
        '/routes',
        '/middleware',
        '/crons',
        '/queues',
        null,
        {
          honoPath: '/hono',
          responsePath: '/response',
          handlerPath: '/handler',
          runtimeEnvPath: '/env',
          projectRoot: '/project',
          homeDir: '/home',
          reactRefresh: false,
          auth: null,
        },
      );
      const source = code.slice(
        code.indexOf('const job0Crons'),
        code.indexOf('const __scheduledHandler'),
      );
      scheduled = new Function(
        'load',
        source.replace('export async function', 'async function').replaceAll('import(', 'load(') +
          '\nreturn scheduled;',
      )(async (path: string) => ({
        default: async (_controller: unknown, env: JobEnv) => {
          const name = path.split('/').pop()!.replace('.mjs', '');
          if (name === 'second') {
            await new Promise((resolve) => setTimeout(resolve, 2));
          }
          env.calls.push(name);
          if (name === 'first' && env.fail) {
            throw new Error('first failed');
          }
        },
      }));
    } else {
      const root = mkdtempSync(join(tmpdir(), 'void-cron-fanout-'));
      roots.push(root);
      mkdirSync(join(root, 'crons'));
      writeFileSync(
        join(root, 'index.mjs'),
        'export default { fetch() { return new Response("app"); } };',
      );
      for (const job of jobs) {
        writeFileSync(
          join(root, 'crons', job.filePath),
          `export default async function(_controller, env) {
        if (${JSON.stringify(job.name)} === 'second') await new Promise(resolve => setTimeout(resolve, 2));
        env.calls.push(${JSON.stringify(job.name)});
        if (${JSON.stringify(job.name)} === 'first' && env.fail) throw new Error('first failed');
      }`,
        );
      }
      await generateWrapper(root, 'index.mjs', root, { auth: null, queues: [], crons: jobs });
      scheduled = (await import(pathToFileURL(join(root, 'index.mjs')).href)).default.scheduled;
    }
    const env: JobEnv = { calls: [], fail: false };
    await scheduled({ cron: '* * * * *' }, env, {});
    expect(env.calls.sort()).toEqual(['first', 'second']);
    env.calls = [];
    env.fail = true;
    await expect(scheduled({ cron: '* * * * *' }, env, {})).rejects.toThrow();
    expect(env.calls.sort()).toEqual(['first', 'second']);
    env.calls = [];
    await scheduled({ cron: '0 2 * * *' }, env, {});
    expect(env.calls).toEqual([]);
  },
);
