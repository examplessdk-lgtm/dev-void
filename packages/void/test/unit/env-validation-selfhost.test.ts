import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  collectPlaintextVarWarnings,
  createDefaultSecretListRunner,
  secretListEnv,
  SelfHostEnvValidationError,
  SelfHostFirstDeployError,
  SelfHostSchemaError,
  SelfHostSecretListError,
  type SecretListRunResult,
  validateSelfHostProdEnv,
} from '../../src/cli/env-validation.ts';
import { number, string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';
import { _resetUnmaskCacheForTests } from '../../src/shared/env-mask.ts';
import type { StandardSchemaV1 } from '../../src/standard-schema.ts';

/**
 * Unit coverage for the self-host (`void deploy --backend cloudflare`)
 * secrets preflight units. No real wrangler and no network anywhere — the
 * gate tests inject a stub `RunSecretList` seam; the default-runner tests
 * launch tiny Node scripts through the launcher seam (same convention as
 * provision.test.ts).
 *
 * Schema registration is done directly via `defineEnv` (a process-wide
 * singleton) with an empty `env.ts` on disk, exactly like
 * test/integration/env-prod-validation.test.ts.
 */

const roots: Array<string> = [];

function createTempProject(opts?: { withEnvTs?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-selfhost-env-'));
  roots.push(root);
  if (opts?.withEnvTs !== false) {
    // Empty module body is enough — schema is pre-registered via defineEnv.
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
  }
  return root;
}

function writeDotenv(root: string, name: string, contents: string): void {
  writeFileSync(join(root, name), contents);
}

beforeEach(() => {
  // Clear any schema that leaked from a prior test. `defineEnv({})` resets
  // the registry (the presence flag stays on, which is fine — an empty
  // schema always validates clean).
  defineEnv({});
});

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// WARN unit — collectPlaintextVarWarnings
// ---------------------------------------------------------------------------

describe('collectPlaintextVarWarnings — plaintext worker-vars classification', () => {
  it('classifies schema-secret (explicit .secret()), heuristic, and benign keys', async () => {
    const root = createTempProject();
    // APP_PEPPER would NOT trip the name heuristic — only the explicit
    // `.secret()` override flags it. API_KEY trips the heuristic. GREETING
    // is benign.
    defineEnv({ APP_PEPPER: string().secret() });
    writeDotenv(
      root,
      '.env.production',
      'APP_PEPPER=super-pepper-value\nAPI_KEY=heuristic-value\nGREETING=hello\n',
    );

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(3);
    expect(result.secretKeys).toEqual([
      { key: 'API_KEY', reason: 'heuristic' },
      { key: 'APP_PEPPER', reason: 'schema-secret' },
    ]);
    // Values must be unreachable from the result — keys only.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-pepper-value');
    expect(serialized).not.toContain('heuristic-value');
    expect(serialized).not.toContain('hello');
  });

  it('still warns a heuristic-looking .public() key — .public() does NOT suppress the heuristic', async () => {
    const root = createTempProject();
    // WIDGET_TOKEN matches the heuristic (TOKEN). `.public()` only means "not a
    // schema secret" — the value still ships as plaintext, so it is still
    // flagged via the heuristic (F1). It is NOT reason `schema-secret`.
    defineEnv({ WIDGET_TOKEN: string().public() });
    writeDotenv(root, '.env.production', 'WIDGET_TOKEN=https://example.com/widget\n');

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(1);
    expect(result.secretKeys).toEqual([{ key: 'WIDGET_TOKEN', reason: 'heuristic' }]);
    // Never the value.
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('warns a secret-valued schema DEFAULT the build bakes into vars, even with no dotenv entry (F1)', async () => {
    const root = createTempProject();
    // API_KEY has a default and NO dotenv entry — applySchemaDefaultsToWorkerVars
    // still bakes it into worker vars as plaintext, so it must be classified.
    // SESSION_SECRET is an explicit .secret() default. GREETING is a benign default.
    defineEnv({
      API_KEY: string().default('sk_live_defaultkey'),
      SESSION_SECRET: string().secret().default('pepper-default'),
      GREETING: string().default('hello'),
    });
    // No .env files at all — the union comes purely from schema defaults.

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(3);
    expect(result.secretKeys).toEqual([
      { key: 'API_KEY', reason: 'heuristic' },
      { key: 'SESSION_SECRET', reason: 'schema-secret' },
    ]);
    // Default VALUES must never be reachable from the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk_live_defaultkey');
    expect(serialized).not.toContain('pepper-default');
    expect(serialized).not.toContain('hello');
  });

  it('classifies via the heuristic alone when the project has no env.ts schema', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env.production', 'DATABASE_PASSWORD=x\nPLAIN=1\n');

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(2);
    expect(result.secretKeys).toEqual([{ key: 'DATABASE_PASSWORD', reason: 'heuristic' }]);
  });

  it('excludes reserved __VOID_* internal keys exactly like the build', async () => {
    const root = createTempProject({ withEnvTs: false });
    // __VOID_TOKEN matches the TOKEN heuristic — if stripInternalEnvKeys were
    // skipped it would show up in secretKeys AND in totalVarKeys.
    writeDotenv(root, '.env.production', '__VOID_TOKEN=hijack\nSAFE=1\n');

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(1);
    expect(result.secretKeys).toEqual([]);
  });

  it('excludes shell-env pollution exactly like the build (filterLoadedEnv)', async () => {
    const root = createTempProject({ withEnvTs: false });
    // Shell-only var with a secret-looking name: if filterLoadedEnv were
    // skipped, loadEnv(mode, dir, '') would surface it and the heuristic
    // would flag it.
    vi.stubEnv('VOID_TEST_SHELL_ONLY_TOKEN', 'from-shell');
    try {
      writeDotenv(root, '.env.production', 'SAFE=1\n');

      const result = await collectPlaintextVarWarnings(root);

      expect(result.totalVarKeys).toBe(1);
      expect(result.secretKeys).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mirrors the build's mode file set: .env + .env.local + .env.production, not .env.development", async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env', 'BASE_SECRET=a\n');
    // The BUILD (loadEnv) reads .env.local — unlike the deploy manifest.
    writeDotenv(root, '.env.local', 'LOCAL_TOKEN=b\n');
    writeDotenv(root, '.env.production', 'PROD_KEY=c\n');
    writeDotenv(root, '.env.development', 'DEV_ONLY_SECRET=d\n');

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(3);
    expect(result.secretKeys.map((s) => s.key)).toEqual(['BASE_SECRET', 'LOCAL_TOKEN', 'PROD_KEY']);
  });

  it('honours the mode option the same way the build does', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env.staging', 'STAGING_KEY=s\n');
    writeDotenv(root, '.env.production', 'PROD_KEY=p\n');

    const result = await collectPlaintextVarWarnings(root, { mode: 'staging' });

    expect(result.secretKeys.map((s) => s.key)).toEqual(['STAGING_KEY']);
  });

  it("resolves envDir relative to root, mirroring envPlugin's userConfig.envDir handling", async () => {
    const root = createTempProject({ withEnvTs: false });
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', '.env.production'), 'NESTED_API_KEY=n\nPLAIN=1\n');
    // A root-level .env.production must be ignored when envDir points elsewhere.
    writeDotenv(root, '.env.production', 'ROOT_KEY=r\n');

    const result = await collectPlaintextVarWarnings(root, { envDir: 'config' });

    expect(result.totalVarKeys).toBe(2);
    expect(result.secretKeys).toEqual([{ key: 'NESTED_API_KEY', reason: 'heuristic' }]);
  });

  it('warns a secret-looking void.json worker.vars key the build bakes into vars, even with no dotenv entry', async () => {
    const root = createTempProject({ withEnvTs: false });
    // The build seeds worker vars from void.json `worker.vars` (index.ts ~924)
    // as PLAINTEXT — with no dotenv entry and no schema default. The effective
    // var union must include it and the heuristic must flag the secret-looking
    // key; the benign one stays out of secretKeys but counts toward the total.
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ worker: { vars: { API_SECRET: 'sk_live_configured', PLAIN: '1' } } }),
    );

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(2);
    expect(result.secretKeys).toEqual([{ key: 'API_SECRET', reason: 'heuristic' }]);
    // Keys only — the configured value must never ride along on the result.
    expect(JSON.stringify(result)).not.toContain('sk_live_configured');
  });

  it('warns a secret-looking JSON-valued root-wrangler var — keys only, value never rides along (F1)', async () => {
    const root = createTempProject({ withEnvTs: false });
    // wrangler 4.107 ships a non-string var as a `type:"json"` binding — still
    // plaintext in the uploaded config. A secret-looking JSON-valued key must be
    // warned, and the (object) value must never be reachable from the result.
    // Pre-fix `readConfigVars` dropped every non-string member, so BOTH keys
    // vanished from the union (totalVarKeys would be 0).
    const configPath = join(root, 'wrangler.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({ name: 'app', vars: { API_KEY: { token: 'sk_live_json_leak' }, COUNT: 5 } }),
    );

    const result = await collectPlaintextVarWarnings(root, { configPath });

    expect(result.totalVarKeys).toBe(2);
    expect(result.secretKeys).toEqual([{ key: 'API_KEY', reason: 'heuristic' }]);
    expect(JSON.stringify(result)).not.toContain('sk_live_json_leak');
  });

  it('DEFAULT invocation (no configPath) still folds in the discovered root-wrangler layer — string + JSON keys (F2)', async () => {
    const root = createTempProject({ withEnvTs: false });
    // The build's LOWEST plaintext layer is the root `wrangler.jsonc` `vars`. The
    // DEFAULT `collectPlaintextVarWarnings(root)` (no configPath) must DISCOVER it
    // the same way the build does and warn its secret-looking members — a
    // string-valued one AND a JSON-valued one. Pre-fix the default call forwarded
    // no configPath, so the root layer was skipped entirely (a THREE-source map).
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'app',
        vars: {
          ROOT_API_KEY: 'sk_live_root_string',
          ROOT_TOKEN: { jwt: 'sk_live_root_json' },
          ROOT_PLAIN: 'benign',
        },
      }),
    );

    // No configPath — discovery must find the root wrangler.jsonc.
    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(3);
    expect(result.secretKeys).toEqual([
      { key: 'ROOT_API_KEY', reason: 'heuristic' },
      { key: 'ROOT_TOKEN', reason: 'heuristic' },
    ]);
    // Keys only — neither the string nor the JSON value may appear anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk_live_root_string');
    expect(serialized).not.toContain('sk_live_root_json');
  });

  it('prefers wrangler.jsonc over wrangler.json when both exist (discovery order)', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({ name: 'app', vars: { ALPHA: 'x' } }),
    );
    writeFileSync(
      join(root, 'wrangler.json'),
      JSON.stringify({ name: 'app', vars: { BETA: 'y' } }),
    );

    const result = await collectPlaintextVarWarnings(root);

    // Only the higher-priority wrangler.jsonc layer is read (build discovery order).
    expect(result.totalVarKeys).toBe(1);
    expect(result.secretKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WARN unit — F5 values-free schema boundary (env.ts load + default probing)
// ---------------------------------------------------------------------------

describe('collectPlaintextVarWarnings — F5 schema load + default probe are values-free', () => {
  const SENTINEL = 'SENTINEL-warn-sk_live_leak-WZX';

  /** Everything an observer could read off the thrown schema error. */
  function serializeSchemaError(error: unknown): string {
    const e = error as SelfHostSchemaError & Record<string, unknown>;
    return JSON.stringify({
      name: e.name,
      message: e.message,
      stack: e.stack ?? '',
      reason: e.reason,
      own: e,
      ownStr: String(e),
    });
  }

  it('a throwing env.ts becomes a values-free SelfHostSchemaError (sentinel nowhere, even under VOID_ENV_UNMASK)', async () => {
    const root = createTempProject({ withEnvTs: false });
    // env.ts evaluation embeds the sentinel; loadUserEnvFile would fold that
    // original message into its wrapper — the WARN-side boundary must drop it.
    writeFileSync(join(root, 'env.ts'), `throw new Error('warn env boom ${SENTINEL}');\n`);

    vi.stubEnv('VOID_ENV_UNMASK', '1');
    _resetUnmaskCacheForTests();
    try {
      const error = await collectPlaintextVarWarnings(root).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSchemaError);
      expect((error as SelfHostSchemaError).reason).toBe('schema-load-failed');
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(serializeSchemaError(error)).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllEnvs();
      _resetUnmaskCacheForTests();
    }
  });

  it('a validator that THROWS synchronously during default-probing becomes a values-free SelfHostSchemaError', async () => {
    const root = createTempProject();
    defineEnv({
      FOO: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate() {
            throw new Error(`warn sync default probe ${SENTINEL}`);
          },
        },
      } satisfies StandardSchemaV1<unknown, unknown>,
    });
    writeDotenv(root, '.env.production', 'API_KEY=x\n');

    vi.stubEnv('VOID_ENV_UNMASK', '1');
    _resetUnmaskCacheForTests();
    try {
      const error = await collectPlaintextVarWarnings(root).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSchemaError);
      expect((error as SelfHostSchemaError).reason).toBe('schema-validation-error');
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(serializeSchemaError(error)).not.toContain(SENTINEL);
    } finally {
      vi.unstubAllEnvs();
      _resetUnmaskCacheForTests();
    }
  });

  it('a rejecting ASYNC default probe never leaks the value nor floats as an unhandled rejection (even under VOID_ENV_UNMASK)', async () => {
    const root = createTempProject();
    // The default probe (validate(undefined)) rejects ASYNC with the sentinel.
    // Under the pre-fix WARN unit, `_getSchemaDefaults` skipped the Promise with
    // no `.catch`, so the rejection floated as an unhandled rejection carrying
    // the sentinel. The fix consumes it and simply skips the key.
    defineEnv({
      FOO: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate() {
            return Promise.reject(new Error(`warn async default probe ${SENTINEL}`));
          },
        },
      } satisfies StandardSchemaV1<unknown, unknown>,
    });
    writeDotenv(root, '.env.production', 'API_KEY=x\n');

    const unhandled: Array<unknown> = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    vi.stubEnv('VOID_ENV_UNMASK', '1');
    _resetUnmaskCacheForTests();
    try {
      // Does not throw — the async probe is consumed and the key skipped.
      const result = await collectPlaintextVarWarnings(root);
      // Give any (buggy) floating rejection a tick to surface.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // API_KEY (from dotenv) is still classified; FOO is not a known default.
      expect(result.secretKeys).toEqual([{ key: 'API_KEY', reason: 'heuristic' }]);
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      const dump = unhandled
        .map((u) => (u instanceof Error ? `${u.message}\n${u.stack ?? ''}` : String(u)))
        .join('\n');
      expect(dump).not.toContain(SENTINEL);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.unstubAllEnvs();
      _resetUnmaskCacheForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// GATE unit — validateSelfHostProdEnv
// ---------------------------------------------------------------------------

function stubRunner(result: SecretListRunResult): {
  run: (args: Array<string>) => SecretListRunResult;
  calls: Array<Array<string>>;
} {
  const calls: Array<Array<string>> = [];
  return {
    calls,
    run: (args: Array<string>) => {
      calls.push(args);
      return result;
    },
  };
}

function okList(names: Array<string>): SecretListRunResult {
  return {
    stdout: JSON.stringify(
      names.map((name) => ({ name, type: 'secret_text' })),
      null,
      '  ',
    ),
    stderr: '',
    status: 0,
  };
}

const CONFIG_PATH = '/tmp/proj/wrangler.jsonc';

describe('validateSelfHostProdEnv — self-host secret gate', () => {
  it('hard-errors naming ONLY the still-missing key when the remote list covers the rest', async () => {
    const root = createTempProject();
    defineEnv({ FOO: string(), BAR: string() });
    const { run } = stubRunner(okList(['FOO']));

    const error = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SelfHostEnvValidationError);
    const envError = error as SelfHostEnvValidationError;
    expect(envError.report.missing).toEqual(['BAR']);
    expect(envError.message).toContain('BAR');
    expect(envError.message).toContain('wrangler secret put');
  });

  it('strips resolved values from the attached report so the error can never echo them', async () => {
    const root = createTempProject();
    defineEnv({ FOO: string(), BAR: string() });
    // FOO validates successfully from a local file — its resolved value must
    // NOT ride along on the thrown error's report.
    writeDotenv(root, '.env.production', 'FOO=local-secret-value\n');
    const { run } = stubRunner(okList([]));

    const error = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SelfHostEnvValidationError);
    const envError = error as SelfHostEnvValidationError;
    expect(envError.report.missing).toEqual(['BAR']);
    expect(envError.report.values.size).toBe(0);
    expect(envError.message).not.toContain('local-secret-value');
  });

  it('passes when remote secrets cover every missing key, using the exact pinned argv', async () => {
    const root = createTempProject();
    defineEnv({ FOO: string(), BAR: string() });
    const { run, calls } = stubRunner(okList(['FOO', 'BAR']));

    const result = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    });

    expect(result).toEqual({ hasSchema: true, remoteSecretNames: ['FOO', 'BAR'] });
    // The exact wrangler invocation: subcommand, pinned JSON format, pinned
    // config path, pinned empty environment.
    expect(calls).toEqual([['secret', 'list', '--format=json', '-c', CONFIG_PATH, '--env=']]);
  });

  it('passes on a mix of local .env values and remote secrets', async () => {
    const root = createTempProject();
    defineEnv({ FOO: string(), BAR: string() });
    writeDotenv(root, '.env.production', 'FOO=local\n');
    const { run } = stubRunner(okList(['BAR']));

    const result = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    });

    expect(result.remoteSecretNames).toEqual(['BAR']);
  });

  it('never invokes wrangler when local .env files already satisfy the schema', async () => {
    const root = createTempProject();
    defineEnv({ FOO: string() });
    writeDotenv(root, '.env.production', 'FOO=present\n');
    const { run, calls } = stubRunner(okList([]));

    const result = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    });

    expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
    expect(calls).toEqual([]);
  });

  it('never invokes wrangler when the project has no env.ts', async () => {
    const root = createTempProject({ withEnvTs: false });
    const { run, calls } = stubRunner(okList([]));

    const result = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    });

    expect(result).toEqual({ hasSchema: false, remoteSecretNames: null });
    expect(calls).toEqual([]);
  });

  it('hard-errors on invalid local values without consulting wrangler (remote cannot fix them)', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });
    writeDotenv(root, '.env.production', 'PORT=not-a-number\n');
    const { run, calls } = stubRunner(okList(['PORT']));

    const error = await validateSelfHostProdEnv(root, {
      configPath: CONFIG_PATH,
      runWrangler: run,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SelfHostEnvValidationError);
    expect((error as SelfHostEnvValidationError).report.invalid.map((i) => i.key)).toEqual([
      'PORT',
    ]);
    expect(calls).toEqual([]);
  });

  // --- F2: present-empty local var must not be discharged by a remote secret ---

  describe('F2 — empty local assignment shadowing a remote secret', () => {
    it('fails closed naming the key when `FOO=` collides with remote FOO (never ships empty over the secret)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // FOO is PRESENT but EMPTY locally — the build bakes `FOO=""` into
      // plaintext vars, which wrangler gives precedence over the remote secret.
      writeDotenv(root, '.env.production', 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('FOO');
      expect(envError.message).toContain('Remove the empty assignment');
      // F3 — names the ACTUAL dotenv file the empty value came from.
      expect(envError.message).toContain('.env.production');
      // Guidance is about removing the assignment, NOT `secret put` (the secret
      // already exists remotely).
      expect(envError.message).not.toContain('wrangler secret put');
    });

    it('a genuinely ABSENT key is still discharged by the same-named remote secret (passes)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // No local FOO at all — remote FOO legitimately satisfies it.
      const { run } = stubRunner(okList(['FOO']));

      const result = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      });

      expect(result).toEqual({ hasSchema: true, remoteSecretNames: ['FOO'] });
    });

    it('fails closed when `FOO=` lives in .env.local — a build-loaded file validateProdEnv does NOT read', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // .env.local is loaded by the BUILD (loadEnv) but NOT by validateProdEnv's
      // productionOnly view — the empty-check must consult the full build map,
      // else FOO reads as ABSENT and the remote secret wrongly discharges it.
      writeDotenv(root, '.env.local', 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('Remove the empty assignment');
      // F3 — names `.env.local` specifically (the winning file), not a generic list.
      expect(envError.message).toContain('.env.local');
      expect(envError.message).not.toContain('wrangler secret put');
    });

    it('fails closed when `FOO=` lives in a custom envDir file the build honours', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      mkdirSync(join(root, 'config'));
      // Empty FOO in the custom envDir the build reads via userConfig.envDir.
      writeFileSync(join(root, 'config', '.env.production'), 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        envDir: 'config',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as SelfHostEnvValidationError).message).toContain(
        'Remove the empty assignment',
      );
    });

    it('fails closed when `FOO=` lives in .env.production.local (build overlay)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeDotenv(root, '.env.production.local', 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as SelfHostEnvValidationError).message).toContain(
        'Remove the empty assignment',
      );
    });

    it('THE REPRO — `.env.production` sets FOO but `.env.production.local` empties it: fails closed (fail-OPEN under the pre-fix fast path)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string(), BAR: string() });
      // productionOnly view (.env + .env.production) sees FOO + BAR non-empty,
      // so `local.report.valid` is TRUE — the pre-fix code returned success
      // right there (the fast path), before ever consulting the build map.
      writeDotenv(root, '.env.production', 'FOO=real-foo\nBAR=real-bar\n');
      // The BUILD (loadEnv) also reads .env.production.local at HIGHER priority,
      // so the effective var map baked into wrangler.json has FOO="". Both are
      // remote secrets, so shipping FOO="" would overwrite the remote FOO.
      writeDotenv(root, '.env.production.local', 'FOO=\n');
      const { run } = stubRunner(okList(['FOO', 'BAR']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      // ONLY the emptied key is named — BAR is genuinely satisfied.
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('FOO');
      expect(envError.message).not.toContain('BAR');
      expect(envError.message).toContain('Remove the empty assignment');
      expect(envError.message).not.toContain('wrangler secret put');
      // F3 — provenance names the WINNING (highest-precedence) file
      // `.env.production.local`, not the lower `.env.production` that set real-foo.
      expect(envError.message).toContain('.env.production.local');
    });

    it('THE REPRO (custom envDir) — root `.env.production` satisfies FOO but the envDir overlay empties it: fails closed', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // validateProdEnv reads the ROOT .env.production → FOO satisfied → local
      // valid → pre-fix fast path returned success.
      writeDotenv(root, '.env.production', 'FOO=real-foo\n');
      // But the BUILD reads envDir=config, whose .env.production empties FOO, so
      // the effective baked var is FOO="" — which would shadow the remote FOO.
      mkdirSync(join(root, 'config'));
      writeFileSync(join(root, 'config', '.env.production'), 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        envDir: 'config',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as SelfHostEnvValidationError).message).toContain(
        'Remove the empty assignment',
      );
    });

    it('a normally-satisfied NON-EMPTY required key passes without a wrangler call', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeDotenv(root, '.env.production', 'FOO=real-foo\n');
      const { run, calls } = stubRunner(okList(['FOO']));

      const result = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      });

      expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
      expect(calls).toEqual([]);
    });

    // A required Standard Schema validator that REJECTS `undefined` (so it is
    // required) but ACCEPTS `""` — exactly like a bare Zod `z.string()`. Used to
    // prove requiredness is derived independently of whether `""` validates.
    const acceptsEmptyButRequired: StandardSchemaV1<unknown, string> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          if (typeof value !== 'string') {
            return { issues: [{ message: 'Required' }] };
          }
          return { value };
        },
      },
    };

    it('F2a — `.env.production.local` empties a required FOO that is NOT remote: fails CLOSED (fail-OPEN under the pre-fix remote-gated empty check)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // productionOnly view (.env + .env.production) sees FOO=real-foo → valid,
      // so the pre-fix fast path / final validateProdEnv both treat FOO as
      // satisfied. The BUILD overlay (.env.production.local) empties it, so the
      // effective baked var is FOO="". wrangler returns [] (FOO is NOT a remote
      // secret), so the pre-fix `emptyOverrides = presentEmpty ∩ remote` is empty
      // → the gate passed and the build shipped FOO="". The fix rejects any
      // present-empty required key regardless of remote membership.
      writeDotenv(root, '.env.production', 'FOO=real-foo\n');
      writeDotenv(root, '.env.production.local', 'FOO=\n');
      const { run } = stubRunner(okList([]));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('FOO');
      expect(envError.message).toContain('Remove the empty assignment');
      expect(envError.message).not.toContain('wrangler secret put');
    });

    it('F2b — a required validator that ACCEPTS "" still fails CLOSED on `FOO=` (fail-OPEN under the pre-fix buildReport.missing source)', async () => {
      const root = createTempProject();
      // FOO rejects undefined (required) but ACCEPTS "". `FOO=` therefore never
      // enters validateAllEnv().missing, so the pre-fix presentEmpty check (which
      // filtered buildReport.missing) saw nothing → the whole F2 gate was bypassed
      // and remote FOO was overwritten by the plaintext empty. The fix derives
      // requiredness independently (probe undefined), so `FOO=` still fails closed.
      defineEnv({ FOO: acceptsEmptyButRequired });
      writeDotenv(root, '.env.production', 'FOO=\n');
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('Remove the empty assignment');
      expect(envError.message).not.toContain('wrangler secret put');
    });

    it('effectively-absent required key (root has FOO but a custom envDir makes it absent) is discharged by the remote secret', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // Root .env.production satisfies FOO in the productionOnly view, so the
      // pre-fix fast path returned success WITHOUT consulting wrangler. But the
      // BUILD reads envDir=config (empty), so the effective build map has NO FOO
      // — it must be discharged by the remote secret, requiring a wrangler call.
      writeDotenv(root, '.env.production', 'FOO=real-foo\n');
      mkdirSync(join(root, 'config'));
      const { run, calls } = stubRunner(okList(['FOO']));

      const result = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        envDir: 'config',
        runWrangler: run,
      });

      expect(result).toEqual({ hasSchema: true, remoteSecretNames: ['FOO'] });
      expect(calls.length).toBe(1);
    });

    it('effectively-absent required key with NO remote secret fails CLOSED as a missing secret', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeDotenv(root, '.env.production', 'FOO=real-foo\n');
      mkdirSync(join(root, 'config'));
      const { run } = stubRunner(okList([]));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        envDir: 'config',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      const envError = error as SelfHostEnvValidationError;
      expect(envError.report.missing).toEqual(['FOO']);
      expect(envError.message).toContain('wrangler secret put');
    });
  });

  // --- Effective build map: configured worker vars (void.json / root wrangler) ---
  //
  // The build assembles the deployed `vars` from FOUR sources (index.ts): root
  // wrangler `vars` (lowest) < schema defaults < void.json `worker.vars` <
  // sanitized dotenv (highest). The gate must judge present/empty/absent over
  // that FINAL resolved map, not the dotenv layer alone — else a configured
  // empty required var reads as ABSENT and a remote secret wrongly discharges
  // it, while the build ships `FOO=""` OVER that remote secret (the F2 fail-open,
  // new source), and a configured non-empty value is misclassified as absent.

  describe('effective build map — configured worker vars', () => {
    function writeVoidJson(root: string, vars: Record<string, string>): void {
      writeFileSync(join(root, 'void.json'), JSON.stringify({ worker: { vars } }));
    }
    function writeWranglerConfig(root: string, config: Record<string, unknown>): string {
      const path = join(root, 'wrangler.jsonc');
      writeFileSync(path, JSON.stringify(config));
      return path;
    }

    it('void.json worker.vars.FOO="" + remote FOO fails CLOSED (fail-OPEN under the dotenv-only pre-fix map)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // Configured empty required var — the build bakes `FOO=""` into plaintext
      // vars, which wrangler gives precedence over the same-named remote secret.
      writeVoidJson(root, { FOO: '' });
      const { run, calls } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as Error).message).toContain('Remove the empty assignment');
      expect((error as Error).message).not.toContain('wrangler secret put');
      // F3 — the error names the ACTUAL source (void.json worker.vars), never .env.
      expect((error as Error).message).toContain('void.json');
      expect((error as Error).message).toContain('worker.vars');
      // Rejected BEFORE any wrangler spawn — remote membership is irrelevant.
      expect(calls).toEqual([]);
    });

    it('root wrangler.jsonc vars.FOO="" + remote FOO fails CLOSED (same fail-open source via the root config)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      const configPath = writeWranglerConfig(root, { name: 'app', vars: { FOO: '' } });
      const { run, calls } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as Error).message).toContain('Remove the empty assignment');
      // F3 — the error names the ACTUAL source (root wrangler.jsonc vars), never .env.
      expect((error as Error).message).toContain('wrangler.jsonc');
      expect((error as Error).message).not.toContain('.env');
      expect(calls).toEqual([]);
    });

    it('void.json worker.vars.FOO="realvalue" counts PRESENT — first deploy passes with wrangler [] (no false block)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeVoidJson(root, { FOO: 'realvalue' });
      const { run, calls } = stubRunner(okList([]));

      const result = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      });

      // Present-and-non-empty in the effective map → satisfied locally, so no
      // wrangler round-trip and no false "missing secret" on a first deploy.
      expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
      expect(calls).toEqual([]);
    });

    it('a non-empty void.json value shadows a root wrangler empty (precedence: void.json > root wrangler) → passes', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // Root wrangler has FOO="" (lowest), void.json overrides it non-empty.
      const configPath = writeWranglerConfig(root, { name: 'app', vars: { FOO: '' } });
      writeVoidJson(root, { FOO: 'from-void-json' });
      const { run, calls } = stubRunner(okList([]));

      const result = await validateSelfHostProdEnv(root, {
        configPath,
        runWrangler: run,
      });

      expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
      expect(calls).toEqual([]);
    });

    it('dotenv OVERRIDES a configured empty back to non-empty (final precedence: dotenv > void.json)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeVoidJson(root, { FOO: '' }); // configured empty (lower precedence)
      writeDotenv(root, '.env.production', 'FOO=real-foo\n'); // dotenv wins
      const { run, calls } = stubRunner(okList([]));

      const result = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      });

      // dotenv value wins → FOO present-non-empty → satisfied locally, no throw.
      expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
      expect(calls).toEqual([]);
    });

    it('dotenv OVERRIDES a configured non-empty to empty → fails CLOSED (final precedence: dotenv > void.json)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      writeVoidJson(root, { FOO: 'configured-real' }); // configured non-empty (lower)
      writeDotenv(root, '.env.production', 'FOO=\n'); // dotenv empties it (wins)
      const { run } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.missing).toEqual(['FOO']);
      expect((error as Error).message).toContain('Remove the empty assignment');
    });
  });

  // --- F1: JSON-valued (non-string) configured vars are PRESENT, not absent ---
  //
  // wrangler 4.107 accepts a var value of ANY JSON type and ships every
  // non-string as a `type:"json"` binding (wrangler-dist/cli.js `case "vars"`),
  // which `checkRemoteSecretsOverride` gives precedence over a same-named remote
  // secret. So a required root-wrangler var with a null/number/object value is
  // PRESENT — satisfied locally, and NEVER discharged by a remote secret. Pre-fix
  // `readConfigVars` dropped every non-string member, so such a key read as
  // ABSENT and a same-named remote secret falsely discharged it while the deploy
  // shipped the JSON var OVER that secret (fail-open).

  describe('effective build map — JSON-valued configured vars (F1)', () => {
    function writeWranglerConfig(root: string, config: Record<string, unknown>): string {
      const path = join(root, 'wrangler.jsonc');
      writeFileSync(path, JSON.stringify(config));
      return path;
    }

    // Rejects `undefined` (so it is REQUIRED) but accepts any defined value —
    // string, number, object, or null — so a present JSON var of any type
    // satisfies the gate locally regardless of type.
    const requiredAcceptsAnything: StandardSchemaV1<unknown, unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value) {
          if (value === undefined) {
            return { issues: [{ message: 'Required' }] };
          }
          return { value };
        },
      },
    };

    it.each([
      { label: 'null', vars: { FOO: null } },
      { label: 'a number', vars: { FOO: 42 } },
      { label: 'an object', vars: { FOO: { nested: true } } },
    ])(
      'a JSON $label root-wrangler var counts PRESENT — a same-named remote secret does NOT discharge it (fail-OPEN pre-fix)',
      async ({ vars }) => {
        const root = createTempProject();
        defineEnv({ FOO: requiredAcceptsAnything });
        const configPath = writeWranglerConfig(root, { name: 'app', vars });
        const { run, calls } = stubRunner(okList(['FOO']));

        const result = await validateSelfHostProdEnv(root, { configPath, runWrangler: run });

        // Present (wrangler ships it as a type:"json" binding) → satisfied
        // locally, remote never consulted. Pre-fix: the non-string member was
        // dropped → FOO read ABSENT → remote FOO discharged it (calls length 1).
        expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
        expect(calls).toEqual([]);
      },
    );

    it('a non-empty JSON object PASSES as present — no false first-deploy block (wrangler [])', async () => {
      const root = createTempProject();
      defineEnv({ FOO: requiredAcceptsAnything });
      const configPath = writeWranglerConfig(root, { name: 'app', vars: { FOO: { k: 'v' } } });
      const { run, calls } = stubRunner(okList([]));

      const result = await validateSelfHostProdEnv(root, { configPath, runWrangler: run });

      // Present-and-non-empty → satisfied locally, so no wrangler round-trip and
      // no false "missing secret" block on a never-deployed worker.
      expect(result).toEqual({ hasSchema: true, remoteSecretNames: null });
      expect(calls).toEqual([]);
    });

    it('a present JSON object the schema REJECTS fails CLOSED as invalid — never remote-discharged', async () => {
      const root = createTempProject();
      // PORT expects a number; a JSON object is present-and-non-empty but invalid
      // (number() coerces via String(obj) → NaN → issues → invalid bucket).
      defineEnv({ PORT: number() });
      const configPath = writeWranglerConfig(root, { name: 'app', vars: { PORT: { nested: 1 } } });
      const { run, calls } = stubRunner(okList(['PORT']));

      const error = await validateSelfHostProdEnv(root, { configPath, runWrangler: run }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.invalid.map((i) => i.key)).toEqual([
        'PORT',
      ]);
      // Malformed present value → fail closed BEFORE any remote discharge.
      expect(calls).toEqual([]);
    });

    it('a present JSON null the schema REJECTS fails CLOSED — never treated as absent/remote-discharged', async () => {
      const root = createTempProject();
      // number() rejects null; validateAllEnv buckets present-null as "missing"
      // (its isMissing covers null), but the gate folds it into invalid (present,
      // non-empty, unvalidated) so it can never be treated as absent and
      // discharged by the remote secret.
      defineEnv({ PORT: number() });
      const configPath = writeWranglerConfig(root, { name: 'app', vars: { PORT: null } });
      const { run, calls } = stubRunner(okList(['PORT']));

      const error = await validateSelfHostProdEnv(root, { configPath, runWrangler: run }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostEnvValidationError);
      expect((error as SelfHostEnvValidationError).report.invalid.map((i) => i.key)).toEqual([
        'PORT',
      ]);
      expect(calls).toEqual([]);
    });
  });

  // --- F3: account reconciled against the config before spawning wrangler ---

  describe('F3 — account reconciliation before spawn', () => {
    function writeConfig(root: string, config: Record<string, unknown>): string {
      const path = join(root, 'wrangler.jsonc');
      writeFileSync(path, JSON.stringify(config));
      return path;
    }

    it('hard-errors (naming both accounts) and NEVER invokes wrangler when config account ≠ option account', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      const configPath = writeConfig(root, { name: 'app', account_id: 'account-X' });
      const { run, calls } = stubRunner(okList(['FOO']));

      const error = await validateSelfHostProdEnv(root, {
        configPath,
        accountId: 'account-Y',
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostEnvValidationError);
      const msg = (error as Error).message;
      expect(msg).toContain('account-X');
      expect(msg).toContain('account-Y');
      // The seam was never consulted — reconciliation failed before any spawn.
      expect(calls).toEqual([]);
    });

    it('proceeds when the config account matches the option account', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      const configPath = writeConfig(root, { name: 'app', account_id: 'account-X' });
      const { run, calls } = stubRunner(okList(['FOO']));

      const result = await validateSelfHostProdEnv(root, {
        configPath,
        accountId: 'account-X',
        runWrangler: run,
      });

      expect(result).toEqual({ hasSchema: true, remoteSecretNames: ['FOO'] });
      expect(calls.length).toBe(1);
    });

    it('proceeds when only one source names an account (config-only)', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      const configPath = writeConfig(root, { name: 'app', account_id: 'account-X' });
      const { run, calls } = stubRunner(okList(['FOO']));

      const result = await validateSelfHostProdEnv(root, {
        configPath,
        // no accountId option
        runWrangler: run,
      });

      expect(result.remoteSecretNames).toEqual(['FOO']);
      expect(calls.length).toBe(1);
    });
  });

  // --- F4: first-deploy (worker-not-found) surfaces a structured, actionable error ---

  describe('F4 — first-deploy worker-not-found', () => {
    // The EXACT UserError wrangler 4.107 emits from `secret list` when the
    // worker does not exist yet — the full fixed block rethrown by
    // secretListCommand.handler after isWorkerNotFoundError(e) (API codes 10007
    // WORKER_NOT_FOUND / 10090 WORKER_LEGACY_ENVIRONMENT_NOT_FOUND). The child
    // sees this MESSAGE, not the numeric code (which is caught and swallowed).
    // Both codes render the identical message, so one positive fixture covers both.
    const WORKER_NOT_FOUND_STDERR =
      'Worker "app" not found.\n\n' +
      'If this is a new Worker, run `wrangler deploy` first to create it.\n' +
      "Otherwise, check that the Worker name is correct and you're logged into the right account.";

    it('throws a structured first-deploy error listing the missing names + secret-put guidance', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string(), API_TOKEN: string() });
      const { run } = stubRunner({ stdout: '', stderr: WORKER_NOT_FOUND_STDERR, status: 1 });

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostFirstDeployError);
      const fde = error as SelfHostFirstDeployError;
      expect(fde.workerNotFound).toBe(true);
      expect([...fde.missingKeys].sort()).toEqual(['API_TOKEN', 'FOO']);
      expect(fde.message).toContain('wrangler secret put FOO');
      expect(fde.message).toContain('wrangler secret put API_TOKEN');
      // Still a fail-closed list error at heart (subclass).
      expect(error).toBeInstanceOf(SelfHostSecretListError);
    });

    it('a generic nonzero exit (auth/network) stays a GENERIC list failure, not first-deploy', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      const { run } = stubRunner({
        stdout: '',
        stderr: 'A request to the Cloudflare API failed. [code: 10000]',
        status: 1,
      });

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostFirstDeployError);
      expect((error as Error).message).toContain('status 1');
    });

    it('M2 — a generic status-1 diagnostic that merely CONTAINS the lead-in phrase is NOT first-deploy', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // A generic wrangler/config diagnostic that happens to include the bare
      // "If this is a new Worker" fragment but NOT the complete structured
      // worker-not-found block (no `Worker "…" not found.` lead, no "Otherwise,
      // check that the Worker name is correct…" sentence). The old substring
      // matcher (/If this is a new Worker/i) misclassified this as first-deploy;
      // it must now stay a GENERIC list failure.
      const { run } = stubRunner({
        stdout: '',
        stderr:
          'Processing wrangler.jsonc configuration:\n' +
          '  - Unexpected fields. If this is a new Worker you may have mistyped a binding name.',
        status: 1,
      });

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostFirstDeployError);
      expect((error as SelfHostSecretListError).reason).toBe('nonzero-exit');
      expect((error as Error).message).toContain('status 1');
    });

    it('M2 — the "If this is a new Worker" sentence WITHOUT the "Otherwise…" line is NOT first-deploy', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      // Even the full deploy-guidance sentence, on its own (no `not found.` lead
      // and no closing "Otherwise…" sentence), is not the complete block.
      const { run } = stubRunner({
        stdout: '',
        stderr: 'Hint: If this is a new Worker, run `wrangler deploy` first to create it.',
        status: 1,
      });

      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostFirstDeployError);
    });
  });

  // --- F5: self-host errors are values-free even under VOID_ENV_UNMASK ---

  describe('F5 — invalid-value errors are values-free', () => {
    it('never echoes the raw invalid value in the message, report, or its JSON — even with VOID_ENV_UNMASK', async () => {
      const root = createTempProject();
      defineEnv({ PORT: number() });
      // A benign key + benign value: redaction would normally KEEP this value,
      // and VOID_ENV_UNMASK disables redaction entirely — yet the self-host
      // error must still never carry the raw input.
      writeDotenv(root, '.env.production', 'PORT=not-a-number\n');
      const { run, calls } = stubRunner(okList([]));

      vi.stubEnv('VOID_ENV_UNMASK', '1');
      _resetUnmaskCacheForTests();
      try {
        const error = await validateSelfHostProdEnv(root, {
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(SelfHostEnvValidationError);
        const envError = error as SelfHostEnvValidationError;
        // Key name is present…
        expect(envError.message).toContain('PORT');
        expect(envError.report.invalid.map((i) => i.key)).toEqual(['PORT']);
        // …but the raw value never is, anywhere.
        expect(envError.message).not.toContain('not-a-number');
        const serialized = JSON.stringify({
          message: envError.message,
          report: {
            missing: envError.report.missing,
            invalid: envError.report.invalid,
            values: [...envError.report.values],
          },
        });
        expect(serialized).not.toContain('not-a-number');
        // Invalid-only local values never consult wrangler.
        expect(calls).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        _resetUnmaskCacheForTests();
      }
    });
  });

  describe('fail-closed wrangler failures (DISTINCT from missing-secret errors)', () => {
    async function expectSecretListError(
      root: string,
      result: SecretListRunResult,
    ): Promise<SelfHostSecretListError> {
      const { run } = stubRunner(result);
      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: run,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error).not.toBeInstanceOf(SelfHostEnvValidationError);
      return error as SelfHostSecretListError;
    }

    function projectMissingFoo(): string {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      return root;
    }

    it('nonzero exit is a hard failure classified structurally (never echoes stderr)', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '',
        stderr: 'A request to the Cloudflare API failed.',
        status: 1,
      });
      // Structural code + safe scalar exit code — but never wrangler's stderr.
      expect(error.reason).toBe('nonzero-exit');
      expect(error.detail.exitCode).toBe(1);
      expect(error.message).toContain('status 1');
      expect(error.message).not.toContain('A request to the Cloudflare API failed.');
    });

    it('a signal-killed child is a hard failure even with status 0', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '[]',
        stderr: '',
        status: 0,
        signal: 'SIGKILL',
      });
      expect(error.reason).toBe('signal');
      expect(error.detail.signal).toBe('SIGKILL');
      expect(error.message).toContain('SIGKILL');
    });

    it('a spawn error is a hard failure classified structurally (never echoes the spawn text)', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '[]',
        stderr: '',
        status: 0,
        error: 'spawn ENOENT',
      });
      expect(error.reason).toBe('spawn-error');
      expect(error.message).not.toContain('spawn ENOENT');
    });

    it('unparseable stdout is a hard failure', async () => {
      const root = projectMissingFoo();
      await expectSecretListError(root, { stdout: 'not json at all', stderr: '', status: 0 });
    });

    it('a non-array JSON payload is a hard failure', async () => {
      const root = projectMissingFoo();
      await expectSecretListError(root, { stdout: '{"secrets":[]}', stderr: '', status: 0 });
    });

    it('ANY malformed list member fails the whole list (fail closed)', async () => {
      const root = projectMissingFoo();
      await expectSecretListError(root, {
        stdout: JSON.stringify([{ name: 'FOO' }, { oops: true }]),
        stderr: '',
        status: 0,
      });
    });

    it('a non-string name is a malformed member', async () => {
      const root = projectMissingFoo();
      await expectSecretListError(root, {
        stdout: JSON.stringify([{ name: 123 }]),
        stderr: '',
        status: 0,
      });
    });

    it('a rejecting seam is wrapped as a hard failure (never echoes the rejection message)', async () => {
      const root = projectMissingFoo();
      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: () => Promise.reject(new Error('boom')),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect((error as SelfHostSecretListError).reason).toBe('spawn-error');
      expect((error as Error).message).not.toContain('boom');
    });
  });

  // --- F5: wrangler failure diagnostics never carry a value, anywhere ---

  describe('F5 — wrangler failure diagnostics are values-free even under VOID_ENV_UNMASK', () => {
    // A sentinel "secret" a hostile/leaky wrangler could echo into stderr/stdout
    // or a spawn/rejection message. It must appear NOWHERE in the thrown error.
    const SENTINEL = 'SENTINEL-sk_live_51H8xLeak-abcXYZ';

    /** Everything an observer could read off the thrown error. */
    function fullySerialize(error: unknown): string {
      const e = error as SelfHostSecretListError & {
        missingKeys?: Array<string>;
        workerNotFound?: boolean;
      };
      return JSON.stringify({
        name: e.name,
        message: e.message,
        stack: e.stack ?? '',
        reason: e.reason,
        detail: e.detail,
        missingKeys: e.missingKeys,
        workerNotFound: e.workerNotFound,
        // The error's own enumerable fields (what JSON.stringify(error) exposes).
        own: e,
        ownStr: String(e),
      });
    }

    async function throwFrom(root: string, result: SecretListRunResult): Promise<unknown> {
      const { run } = stubRunner(result);
      return validateSelfHostProdEnv(root, { configPath: CONFIG_PATH, runWrangler: run }).then(
        () => null,
        (e: unknown) => e,
      );
    }

    function missingFooProject(): string {
      const root = createTempProject();
      defineEnv({ FOO: string() });
      return root;
    }

    it.each([
      {
        label: 'nonzero exit (sentinel in stderr)',
        result: { stdout: '', stderr: `boom ${SENTINEL}`, status: 1 } as SecretListRunResult,
        reason: 'nonzero-exit',
      },
      {
        label: 'signal (sentinel in stderr)',
        result: {
          stdout: '',
          stderr: `killed ${SENTINEL}`,
          status: 0,
          signal: 'SIGKILL',
        } as SecretListRunResult,
        reason: 'signal',
      },
      {
        label: 'spawn error (sentinel in the error text)',
        result: {
          stdout: '',
          stderr: '',
          status: 0,
          error: `spawn failed leaking ${SENTINEL}`,
        } as SecretListRunResult,
        reason: 'spawn-error',
      },
      {
        label: 'malformed stdout (sentinel in stdout)',
        result: { stdout: `not-json ${SENTINEL}`, stderr: '', status: 0 } as SecretListRunResult,
        reason: 'malformed-output',
      },
    ])(
      'the thrown error is sentinel-free in message/fields/JSON — $label',
      async ({ result, reason }) => {
        const root = missingFooProject();
        vi.stubEnv('VOID_ENV_UNMASK', '1');
        _resetUnmaskCacheForTests();
        try {
          const error = (await throwFrom(root, result)) as SelfHostSecretListError;
          expect(error).toBeInstanceOf(SelfHostSecretListError);
          expect(error.reason).toBe(reason);
          expect(error.message).not.toContain(SENTINEL);
          expect(fullySerialize(error)).not.toContain(SENTINEL);
        } finally {
          vi.unstubAllEnvs();
          _resetUnmaskCacheForTests();
        }
      },
    );

    it('a rejecting seam whose message carries the sentinel throws sentinel-free', async () => {
      const root = missingFooProject();
      const error = (await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: () => Promise.reject(new Error(`rejected with ${SENTINEL}`)),
      }).then(
        () => null,
        (e: unknown) => e,
      )) as SelfHostSecretListError;
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect(error.reason).toBe('spawn-error');
      expect(error.message).not.toContain(SENTINEL);
      expect(fullySerialize(error)).not.toContain(SENTINEL);
    });

    it('first-deploy classification STILL fires from the (internal-only) output, sentinel-free', async () => {
      const root = createTempProject();
      defineEnv({ FOO: string(), API_TOKEN: string() });
      // The worker-not-found signal AND a sentinel share the child's stderr: the
      // signal must be read (classification), the sentinel must not leak. The
      // full structured block is present (M2), with the sentinel embedded.
      const error = (await throwFrom(root, {
        stdout: '',
        stderr:
          `Worker "app" not found. ${SENTINEL}\n\n` +
          'If this is a new Worker, run `wrangler deploy` first to create it.\n' +
          "Otherwise, check that the Worker name is correct and you're logged into the right account.",
        status: 1,
      })) as SelfHostFirstDeployError;
      expect(error).toBeInstanceOf(SelfHostFirstDeployError);
      expect(error.workerNotFound).toBe(true);
      expect([...error.missingKeys].sort()).toEqual(['API_TOKEN', 'FOO']);
      expect(error.message).toContain('wrangler secret put FOO');
      expect(error.message).not.toContain(SENTINEL);
      expect(fullySerialize(error)).not.toContain(SENTINEL);
    });
  });

  // --- F5: thrown schema-load / validator exceptions never carry a value ---

  describe('F5 — schema evaluation/validation throws are values-free even under VOID_ENV_UNMASK', () => {
    const SENTINEL = 'SENTINEL-schema-sk_live_leak-QQZ';

    /** Everything an observer could read off the thrown schema error. */
    function serializeSchemaError(error: unknown): string {
      const e = error as SelfHostSchemaError & Record<string, unknown>;
      return JSON.stringify({
        name: e.name,
        message: e.message,
        stack: e.stack ?? '',
        reason: e.reason,
        own: e,
        ownStr: String(e),
      });
    }

    it('a validator that THROWS synchronously (embedding a value) becomes a values-free schema error', async () => {
      const root = createTempProject();
      defineEnv({
        FOO: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate() {
              throw new Error(`validator rejected ${SENTINEL}`);
            },
          },
        } satisfies StandardSchemaV1<unknown, unknown>,
      });
      const { run, calls } = stubRunner(okList([]));

      vi.stubEnv('VOID_ENV_UNMASK', '1');
      _resetUnmaskCacheForTests();
      try {
        const error = await validateSelfHostProdEnv(root, {
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(SelfHostSchemaError);
        expect((error as SelfHostSchemaError).reason).toBe('schema-validation-error');
        expect((error as Error).message).not.toContain(SENTINEL);
        expect(serializeSchemaError(error)).not.toContain(SENTINEL);
        // Threw during local validation — wrangler is never consulted.
        expect(calls).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        _resetUnmaskCacheForTests();
      }
    });

    it('a validator that REJECTS asynchronously (embedding a value) becomes a values-free schema error', async () => {
      const root = createTempProject();
      defineEnv({
        FOO: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate() {
              return Promise.reject(new Error(`async validator rejected ${SENTINEL}`));
            },
          },
        } satisfies StandardSchemaV1<unknown, unknown>,
      });
      const { run } = stubRunner(okList([]));

      vi.stubEnv('VOID_ENV_UNMASK', '1');
      _resetUnmaskCacheForTests();
      try {
        const error = await validateSelfHostProdEnv(root, {
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(SelfHostSchemaError);
        expect((error as SelfHostSchemaError).reason).toBe('schema-validation-error');
        expect((error as Error).message).not.toContain(SENTINEL);
        expect(serializeSchemaError(error)).not.toContain(SENTINEL);
      } finally {
        vi.unstubAllEnvs();
        _resetUnmaskCacheForTests();
      }
    });

    it('an env.ts that THROWS at evaluation (embedding a value) becomes a values-free schema error', async () => {
      const root = createTempProject({ withEnvTs: false });
      // A module that throws at evaluation, embedding the sentinel. Node's
      // import() rejects; loadUserEnvFile would fold that message into its
      // wrapper — the boundary must drop it.
      writeFileSync(join(root, 'env.ts'), `throw new Error('env boom ${SENTINEL}');\n`);
      const { run, calls } = stubRunner(okList([]));

      vi.stubEnv('VOID_ENV_UNMASK', '1');
      _resetUnmaskCacheForTests();
      try {
        const error = await validateSelfHostProdEnv(root, {
          configPath: CONFIG_PATH,
          runWrangler: run,
        }).then(
          () => null,
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(SelfHostSchemaError);
        expect((error as SelfHostSchemaError).reason).toBe('schema-load-failed');
        expect((error as Error).message).not.toContain(SENTINEL);
        expect(serializeSchemaError(error)).not.toContain(SENTINEL);
        // Threw during schema load — wrangler is never consulted.
        expect(calls).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        _resetUnmaskCacheForTests();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Default runner — createDefaultSecretListRunner (launcher seam, no wrangler)
// ---------------------------------------------------------------------------

describe('createDefaultSecretListRunner — async spawn with fail-closed provenance', () => {
  function writeScript(root: string, name: string, source: string): string {
    const file = join(root, name);
    writeFileSync(file, source);
    return file;
  }

  it('captures stdout/stderr and a clean exit 0', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(
      root,
      'ok.mjs',
      `process.stdout.write(JSON.stringify([{ name: 'FOO', type: 'secret_text' }]));\n` +
        `process.stderr.write('note');\n`,
    );
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });

    const result = await run(['secret', 'list', '--format=json', '-c', CONFIG_PATH, '--env=']);

    expect(result.status).toBe(0);
    expect(result.signal ?? null).toBeNull();
    expect(result.error ?? null).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual([{ name: 'FOO', type: 'secret_text' }]);
    expect(result.stderr).toBe('note');
  });

  it('reports a nonzero exit as-is (the gate classifies it as a hard failure)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(root, 'fail.mjs', `process.exit(3);\n`);
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 30_000,
    });

    const result = await run(['secret', 'list']);

    expect(result.status).toBe(3);
  });

  it('SIGKILLs a hung child at the hard timeout and reports the signal', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(root, 'hang.mjs', `setInterval(() => {}, 1 << 30);\n`);
    const run = createDefaultSecretListRunner(root, {
      launcher: [process.execPath, script],
      timeoutMs: 300,
    });

    const result = await run(['secret', 'list']);

    expect(result.signal).toBe('SIGKILL');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('timeout');
  }, 15_000);

  it('reports an unspawnable launcher as an error (never a clean exit)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const run = createDefaultSecretListRunner(root, {
      launcher: [join(root, 'does-not-exist-binary')],
      timeoutMs: 5_000,
    });

    const result = await run(['secret', 'list']);

    expect(result.error).toBeTruthy();
    expect(result.status).not.toBe(0);
  });

  describe('secretListEnv — child env pinning', () => {
    it('scrubs the CF Access pair, pins sanitized logging, and pins the account id', () => {
      vi.stubEnv('CF_ACCESS_CLIENT_ID', 'id');
      vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'secret');
      vi.stubEnv('WRANGLER_LOG_SANITIZE', 'false');
      try {
        const env = secretListEnv('acct-1');
        expect(env.CF_ACCESS_CLIENT_ID).toBeUndefined();
        expect(env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
        expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('leaves ambient transport env (CLOUDFLARE_API_BASE_URL) untouched', () => {
      vi.stubEnv('CLOUDFLARE_API_BASE_URL', 'https://api.staging.example/client/v4');
      try {
        const env = secretListEnv('acct-1');
        expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.staging.example/client/v4');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('scrubs every case-variant of scrubbed/pinned keys on win32 so no ambient spelling can shadow a pin', () => {
      vi.stubEnv('Cloudflare_Account_Id', 'ambient-other-account');
      vi.stubEnv('Wrangler_Log_Sanitize', 'false');
      vi.stubEnv('Cf_Access_Client_Id', 'id');
      try {
        const env = secretListEnv('acct-1', 'win32');
        expect(env.Cloudflare_Account_Id).toBeUndefined();
        expect(env.Wrangler_Log_Sanitize).toBeUndefined();
        expect(env.Cf_Access_Client_Id).toBeUndefined();
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
        expect(env.WRANGLER_LOG_SANITIZE).toBe('true');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('keeps case-variants on POSIX (genuinely different variables there)', () => {
      vi.stubEnv('Cloudflare_Account_Id', 'lowercase-cousin');
      try {
        const env = secretListEnv('acct-1', 'linux');
        expect(env.Cloudflare_Account_Id).toBe('lowercase-cousin');
        expect(env.CLOUDFLARE_ACCOUNT_ID).toBe('acct-1');
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('pins CLOUDFLARE_ACCOUNT_ID and scrubs the CF Access pair in the child env', async () => {
    const root = createTempProject({ withEnvTs: false });
    const script = writeScript(
      root,
      'env.mjs',
      `process.stdout.write(JSON.stringify({\n` +
        `  account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,\n` +
        `  accessId: process.env.CF_ACCESS_CLIENT_ID ?? null,\n` +
        `  accessSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? null,\n` +
        `  sanitize: process.env.WRANGLER_LOG_SANITIZE ?? null,\n` +
        `}));\n`,
    );
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'service-token-id');
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'service-token-secret');
    try {
      const run = createDefaultSecretListRunner(root, {
        accountId: 'acct-123',
        launcher: [process.execPath, script],
        timeoutMs: 30_000,
      });

      const result = await run(['secret', 'list']);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        account: 'acct-123',
        accessId: null,
        accessSecret: null,
        sanitize: 'true',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
