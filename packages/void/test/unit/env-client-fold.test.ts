import { beforeEach, describe, expect, it } from 'vitest';
import { envClientFoldPlugin } from '../../src/plugin-env-client-fold';
import { number, string } from '../../src/runtime/env-helpers';
import { defineEnv } from '../../src/runtime/env-public';

const ROOT = '/project';

interface TransformResult {
  code?: string;
  map?: unknown;
}

function makeContext(environmentName = 'client') {
  return {
    environment: { name: environmentName },
    errors: [] as { message: string }[],
    warnings: [] as { message: string }[],
    error(payload: any) {
      this.errors.push(typeof payload === 'string' ? { message: payload } : payload);
      throw new Error(typeof payload === 'string' ? payload : payload.message);
    },
    warn(payload: any) {
      this.warnings.push(typeof payload === 'string' ? { message: payload } : payload);
    },
  };
}

function getTransformHandler(plugin: ReturnType<typeof envClientFoldPlugin>) {
  const t = plugin.transform;
  if (typeof t === 'function') {
    return t as any;
  }
  if (t && typeof t === 'object' && 'handler' in t) {
    return (t as any).handler;
  }
  throw new Error('plugin.transform missing handler');
}

function getConfigResolvedHandler(plugin: ReturnType<typeof envClientFoldPlugin>) {
  const c = plugin.configResolved;
  if (typeof c === 'function') {
    return c as any;
  }
  if (c && typeof c === 'object' && 'handler' in c) {
    return (c as any).handler;
  }
  return null;
}

interface RunOpts {
  envPrefix?: string | string[];
  env?: Record<string, string>;
  environmentName?: string;
}

async function runFold(
  code: string,
  id: string,
  opts: RunOpts = {},
): Promise<{ ctx: ReturnType<typeof makeContext>; result: TransformResult | undefined | null }> {
  const plugin = envClientFoldPlugin();
  const ctx = makeContext(opts.environmentName ?? 'client');
  const cr = getConfigResolvedHandler(plugin);
  if (cr) {
    await cr.call(ctx, {
      envPrefix: opts.envPrefix ?? 'VITE_',
      env: opts.env ?? {},
    });
  }
  const handler = getTransformHandler(plugin);
  const result = (await handler.call(ctx, code, id)) as TransformResult | undefined | null;
  return { ctx, result };
}

function resetSchema() {
  defineEnv({});
}

describe('envClientFoldPlugin', () => {
  beforeEach(() => {
    resetSchema();
  });

  it('folds a VITE_-prefixed key with a .env value into a string literal', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result?.code).toBeDefined();
    expect(result!.code).toContain(`console.log("Hello")`);
    expect(result!.code).not.toContain('env.VITE_TITLE');
  });

  it('folds env["VITE_FOO"] bracket access with a string literal', async () => {
    const code = `import { env } from "void/env";\nconst v = env["VITE_API"];\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_API: 'https://api.example' },
    });
    expect(result?.code).toContain(`"https://api.example"`);
    expect(result!.code).not.toContain('env["VITE_API"]');
  });

  it('does NOT fold server-only keys (no prefix match)', async () => {
    const code = `import { env } from "void/env";\nconst v = env.STRIPE_KEY;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      // Server keys aren't in config.env (Vite filters them out), but even
      // if a user somehow passes one, prefix enforcement keeps us honest.
      env: { STRIPE_KEY: 'sk_live_secret' },
    });
    expect(result).toBeFalsy();
  });

  it('leaves dynamic computed access (env[key]) for the runtime Proxy', async () => {
    const code = [
      `import { env } from "void/env";`,
      `const key = "VITE_TITLE";`,
      `console.log(env[key]);`,
    ].join('\n');
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('honours a custom envPrefix string', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.PUBLIC_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      envPrefix: 'PUBLIC_',
      env: { PUBLIC_TITLE: 'Public' },
    });
    expect(result?.code).toContain(`"Public"`);
  });

  it('honours a custom envPrefix array', async () => {
    const code = [
      `import { env } from "void/env";`,
      `const a = env.PUBLIC_A;`,
      `const b = env.NEXT_PUBLIC_B;`,
    ].join('\n');
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      envPrefix: ['PUBLIC_', 'NEXT_PUBLIC_'],
      env: { PUBLIC_A: 'aa', NEXT_PUBLIC_B: 'bb' },
    });
    expect(result?.code).toContain(`"aa"`);
    expect(result?.code).toContain(`"bb"`);
  });

  it('leaves unknown keys untouched so the runtime Proxy can serve them', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_MISSING);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: {},
    });
    expect(result).toBeFalsy();
  });

  it('is a no-op for non-client environments (ssr / worker)', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    for (const envName of ['ssr', 'worker', 'rsc']) {
      const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
        environmentName: envName,
        env: { VITE_TITLE: 'Hello' },
      });
      expect(result, `env ${envName}`).toBeFalsy();
    }
  });

  it('skips node_modules', async () => {
    const code = `import { env } from "void/env";\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/node_modules/lib/index.js`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('folds namespace imports (`import * as voidEnv`)', async () => {
    const code = `import * as voidEnv from "void/env";\nconst t = voidEnv.env.VITE_TITLE;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Ns' },
    });
    expect(result?.code).toContain(`"Ns"`);
    expect(result!.code).not.toContain('voidEnv.env.VITE_TITLE');
  });

  it('folds renamed imports (`import { env as e }`)', async () => {
    const code = `import { env as e } from "void/env";\nconst t = e.VITE_TITLE;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'R' },
    });
    expect(result?.code).toContain(`"R"`);
  });

  it('fast-paths files with no `void/env` mention', async () => {
    const code = `const env = { VITE_TITLE: "x" };\nconsole.log(env.VITE_TITLE);\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'Hello' },
    });
    expect(result).toBeFalsy();
  });

  it('handles multiple folds in one file', async () => {
    const code = [`import { env } from "void/env";`, `console.log(env.VITE_A, env.VITE_B);`].join(
      '\n',
    );
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_A: '1', VITE_B: '2' },
    });
    expect(result?.code).toContain(`console.log("1", "2")`);
  });

  it('falls back to schema defaults when a key is absent from .env', async () => {
    defineEnv({ VITE_PORT: number().default(3000) });
    const code = `import { env } from "void/env";\nconst p = env.VITE_PORT;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: {}, // nothing from .env; schema default should kick in
    });
    expect(result?.code).toContain(`"3000"`);
  });

  it('does not expose server-only schema defaults to the client', async () => {
    // Server-only default must not leak into fold output even if it has a
    // default — it still fails the prefix check.
    defineEnv({ PORT: number().default(3000) });
    const code = `import { env } from "void/env";\nconst p = env.PORT;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: {},
    });
    expect(result).toBeFalsy();
  });

  it('prefers .env value over schema default', async () => {
    defineEnv({ VITE_TITLE: string().default('Default') });
    const code = `import { env } from "void/env";\nconst t = env.VITE_TITLE;\n`;
    const { result } = await runFold(code, `${ROOT}/src/page.ts`, {
      env: { VITE_TITLE: 'FromEnv' },
    });
    expect(result?.code).toContain(`"FromEnv"`);
    expect(result!.code).not.toContain('Default');
  });

  it('reports apply: build and enforce: post', () => {
    const plugin = envClientFoldPlugin();
    expect(plugin.apply).toBe('build');
    // `enforce: 'post'` ensures we run AFTER framework SFC compilers (Svelte,
    // Vue, Astro) so `.svelte`/`.vue`/`.astro` ids arrive as compiled JS we
    // can parse and fold.
    expect(plugin.enforce).toBe('post');
  });
});
