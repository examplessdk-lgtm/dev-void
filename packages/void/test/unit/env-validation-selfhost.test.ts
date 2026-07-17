import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  collectPlaintextVarWarnings,
  createDefaultSecretListRunner,
  secretListEnv,
  SelfHostEnvValidationError,
  SelfHostSecretListError,
  type SecretListRunResult,
  validateSelfHostProdEnv,
} from '../../src/cli/env-validation.ts';
import { number, string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';

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

  it('lets an explicit .public() override suppress the name heuristic', async () => {
    const root = createTempProject();
    // WIDGET_TOKEN matches the heuristic (TOKEN) but is explicitly public.
    defineEnv({ WIDGET_TOKEN: string().public() });
    writeDotenv(root, '.env.production', 'WIDGET_TOKEN=https://example.com/widget\n');

    const result = await collectPlaintextVarWarnings(root);

    expect(result.totalVarKeys).toBe(1);
    expect(result.secretKeys).toEqual([]);
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

    it('nonzero exit is a hard failure, never "no secrets exist"', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '',
        stderr: 'A request to the Cloudflare API failed.',
        status: 1,
      });
      expect(error.message).toContain('status 1');
      expect(error.message).toContain('A request to the Cloudflare API failed.');
    });

    it('a signal-killed child is a hard failure even with status 0', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '[]',
        stderr: '',
        status: 0,
        signal: 'SIGKILL',
      });
      expect(error.message).toContain('SIGKILL');
    });

    it('a spawn error is a hard failure even with status 0', async () => {
      const root = projectMissingFoo();
      const error = await expectSecretListError(root, {
        stdout: '[]',
        stderr: '',
        status: 0,
        error: 'spawn ENOENT',
      });
      expect(error.message).toContain('spawn ENOENT');
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

    it('a rejecting seam is wrapped as a hard failure', async () => {
      const root = projectMissingFoo();
      const error = await validateSelfHostProdEnv(root, {
        configPath: CONFIG_PATH,
        runWrangler: () => Promise.reject(new Error('boom')),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SelfHostSecretListError);
      expect((error as Error).message).toContain('boom');
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
