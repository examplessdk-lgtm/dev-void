import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathslash';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// Runs the REAL `mergeBindings` closure: `voidPlugin()` hands it to the
// Cloudflare plugin as `config`, and the mock captures it. The Cloudflare
// plugin then `defu`-merges the returned object over the `resolved` config it
// passed in, so a key can only be REMOVED by mutating `resolved` — which is
// what the `send_email` assertions below check on both objects.
type MockCloudflarePluginConfig = {
  config: (resolved: Record<string, unknown>) => Record<string, unknown>;
};

type MockCloudflarePlugin = Plugin & {
  api: {
    pluginConfig: MockCloudflarePluginConfig;
  };
};

vi.mock('@cloudflare/vite-plugin', () => ({
  cloudflare(pluginConfig: MockCloudflarePluginConfig): Array<MockCloudflarePlugin> {
    return [
      {
        name: 'mock:cloudflare',
        api: { pluginConfig },
      },
    ];
  },
}));

const tempDirs: Array<string> = [];

function createProjectRoot(
  voidConfig: Record<string, unknown> = {},
  { usesVoidEmail = true }: { usesVoidEmail?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'void-email-config-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' }, ...voidConfig }),
  );
  mkdirSync(join(root, 'routes/api'), { recursive: true });
  if (usesVoidEmail) {
    // An app that actually sends mail, so `needsEmail` is inferred the way it
    // would be for a real project rather than forced through config.
    writeFileSync(
      join(root, 'routes/api/notify.ts'),
      `
import { sendEmail } from "void/email";

export async function POST() {
  await sendEmail({ to: "a@example.com", subject: "hi", text: "hi" });
  return Response.json({});
}
`,
    );
  } else {
    // An app that never imports `void/email` and drives Cloudflare's email
    // API through its own binding, so `needsEmail` is inferred false.
    writeFileSync(
      join(root, 'routes/api/notify.ts'),
      `
import { env } from "cloudflare:workers";

export async function POST() {
  await env.MAILER.send({});
  return Response.json({});
}
`,
    );
  }
  return root;
}

function getHookHandler<T>(hook: T | { handler: T } | undefined): T {
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && typeof hook === 'object' && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected Vite hook handler.');
}

async function resolveCloudflareConfig(
  root: string,
  resolved: Record<string, unknown>,
  configEnv: import('vite').ConfigEnv,
): Promise<Record<string, unknown>> {
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  const { voidPlugin } = await import('../../src/index.ts');
  const plugins = voidPlugin();

  const envPlugin = plugins.find((plugin) => plugin.name === 'void:env');
  const config = getHookHandler(envPlugin?.config) as (
    config: import('vite').UserConfig,
    env: import('vite').ConfigEnv,
  ) => void;
  config({}, configEnv);

  const cloudflarePlugin = plugins.find(
    (plugin): plugin is MockCloudflarePlugin => plugin.name === 'mock:cloudflare',
  );
  if (!cloudflarePlugin) {
    throw new Error('Expected mocked Cloudflare plugin.');
  }

  return cloudflarePlugin.api.pluginConfig.config(resolved);
}

const SERVE: import('vite').ConfigEnv = { command: 'serve', mode: 'development' };
const BUILD: import('vite').ConfigEnv = { command: 'build', mode: 'production' };

/** A root wrangler.jsonc as `void deploy --platform cloudflare` leaves it. */
function provisionedRootConfig(): Record<string, unknown> {
  return {
    assets: { binding: 'ASSETS' },
    send_email: [{ name: 'SEND_EMAIL' }],
    vars: { __VOID_EMAIL_FROM: 'Acme <noreply@mail.acme.com>' },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('mergeBindings email config (void dev)', () => {
  it('strips send_email under serve so the dev inbox is the only sink', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = provisionedRootConfig();

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    // Removed from the object the Cloudflare plugin merges over, and not
    // re-added by the returned patch.
    expect('send_email' in resolved).toBe(false);
    expect('send_email' in result).toBe(false);
  });

  it('injects __VOID_EMAIL_FROM from void.json email.from under serve', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    expect((result.vars as Record<string, string>).__VOID_EMAIL_FROM).toBe(
      'Acme <noreply@mail.acme.com>',
    );
  });

  it('does not invent a sender when email.from is unset', async () => {
    const root = createProjectRoot();

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, SERVE);

    expect((result.vars as Record<string, string> | undefined)?.__VOID_EMAIL_FROM).toBeUndefined();
  });

  it('strips send_email under serve even when email.from is unset', async () => {
    const root = createProjectRoot();
    const resolved = { send_email: [{ name: 'SEND_EMAIL' }] };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect('send_email' in resolved).toBe(false);
    expect('send_email' in result).toBe(false);
  });

  it('preserves a user send_email binding when the app does not import void/email', async () => {
    // Nothing in this app goes through `sendEmail`, so the strip has nothing
    // to guard: the user's own binding must reach miniflare exactly as
    // wrangler.jsonc declares it, or `env.MAILER.send()` is a dev-only crash.
    const root = createProjectRoot({}, { usesVoidEmail: false });
    const resolved = {
      assets: { binding: 'ASSETS' },
      send_email: [{ name: 'MAILER', destination_address: 'ops@example.com' }],
    };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect(resolved.send_email).toEqual([
      { name: 'MAILER', destination_address: 'ops@example.com' },
    ]);
    // Not re-added by the patch either: defu concatenates arrays, so a patch
    // entry would double the binding rather than replace it.
    expect('send_email' in result).toBe(false);
  });

  it('leaves a SEND_EMAIL entry alone when the app does not import void/email', async () => {
    // The same `needsEmail` that arms the dev inbox gates the strip. Without
    // `void/email` in the app, `sendEmail` never runs, so a `SEND_EMAIL` entry
    // is either a stale leftover nothing reads or the user's own choice of
    // name — both belong to the root config, as `void deploy` also treats them.
    const root = createProjectRoot({}, { usesVoidEmail: false });
    const resolved = { send_email: [{ name: 'SEND_EMAIL' }] };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect(resolved.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect('send_email' in result).toBe(false);
  });

  it('strips only the SEND_EMAIL entry when the app also carries its own binding', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = {
      ...provisionedRootConfig(),
      send_email: [{ name: 'MAILER' }, { name: 'SEND_EMAIL' }, { name: 'ALERTS' }],
    };

    const result = await resolveCloudflareConfig(root, resolved, SERVE);

    expect(resolved.send_email).toEqual([{ name: 'MAILER' }, { name: 'ALERTS' }]);
    expect('send_email' in result).toBe(false);
  });
});

describe('mergeBindings email config (build)', () => {
  it('passes a root send_email binding through untouched', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });
    const resolved = provisionedRootConfig();

    const result = await resolveCloudflareConfig(root, resolved, BUILD);

    // The root entry survives on `resolved` and the patch does not clobber it
    // (defu concatenates arrays, so a patch entry would double the binding).
    expect(resolved.send_email).toEqual([{ name: 'SEND_EMAIL' }]);
    expect('send_email' in result).toBe(false);
  });

  it('leaves __VOID_EMAIL_FROM to the root wrangler config on build', async () => {
    const root = createProjectRoot({ email: { from: 'Acme <noreply@mail.acme.com>' } });

    const result = await resolveCloudflareConfig(root, { assets: { binding: 'ASSETS' } }, BUILD);

    // Not injected by the plugin: the CLI writes it into the root wrangler.jsonc
    // only once the domain is set up, and the managed deploy supplies its own.
    expect((result.vars as Record<string, string> | undefined)?.__VOID_EMAIL_FROM).toBeUndefined();
  });
});
