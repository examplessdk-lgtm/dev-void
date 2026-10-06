import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  formatEnvReport,
  validateProdEnv,
  validateSecretValues,
} from '../../src/cli/env-validation.ts';
import { number, string } from '../../src/runtime/env-helpers.ts';
import { defineEnv } from '../../src/runtime/env-public.ts';

/**
 * Integration coverage for the deploy-time env validation path. The
 * `assertEnvSchemaValid` wrapper inside `deploy.ts` is a thin layer over
 * `validateProdEnv` — it resolves the remote secret list, calls
 * `validateProdEnv`, and throws when the report is invalid. Exercising
 * `validateProdEnv` across the local `.env`, build shell, and remote
 * secret sources is what catches the
 * regressions that silently break `void deploy`.
 *
 * Schema registration is done directly via `defineEnv` rather than via an
 * `await import(envFile)` round-trip, because the fixture only needs
 * `findEnvFile` to return non-null for the schema-load branch to fire —
 * the actual schema is a process-wide singleton. An empty env.ts on disk
 * keeps the file-discovery contract honest.
 */

const roots: Array<string> = [];

function createTempProject(opts?: { withEnvTs?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'void-deploy-env-'));
  roots.push(root);
  if (opts?.withEnvTs !== false) {
    // Empty module body is enough — schema is pre-registered via defineEnv below.
    writeFileSync(join(root, 'env.ts'), 'export default {};\n');
  }
  return root;
}

function writeDotenv(root: string, name: string, contents: string): void {
  writeFileSync(join(root, name), contents);
}

beforeEach(() => {
  // Clear any schema that leaked from a prior test so missing-key reports
  // are predictable. `defineEnv({})` resets the registry.
  defineEnv({});
});

describe('validateSecretValues — upload-time validation', () => {
  it('accepts declared server values that pass env.ts validation', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });

    await expect(
      validateSecretValues(root, [{ name: 'PORT', value: '8080' }]),
    ).resolves.toBeUndefined();
  });

  it('rejects invalid values without echoing the plaintext', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });

    await expect(
      validateSecretValues(root, [{ name: 'PORT', value: 'not-a-number' }]),
    ).rejects.toThrow('PORT failed env.ts validation');
  });

  it('rejects undeclared and client-exposed names', async () => {
    const root = createTempProject();
    defineEnv({ SERVER_URL: string(), VITE_API_URL: string() });

    await expect(validateSecretValues(root, [{ name: 'OTHER', value: 'x' }])).rejects.toThrow(
      'OTHER is not declared in env.ts',
    );
    await expect(
      validateSecretValues(root, [{ name: 'VITE_API_URL', value: 'https://example.com' }]),
    ).rejects.toThrow('VITE_API_URL is client-exposed');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('validateProdEnv — deploy-time schema enforcement', () => {
  it('returns hasSchema=false when the project has no env.ts (skips validation)', async () => {
    const root = createTempProject({ withEnvTs: false });
    const result = await validateProdEnv(root, { productionOnly: true });
    expect(result.hasSchema).toBe(false);
    expect(result.report.valid).toBe(true);
  });

  it('reports missing required keys when no remote secrets supply them', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), DATABASE_URL: string() });

    const { hasSchema, report } = await validateProdEnv(root, { productionOnly: true });

    expect(hasSchema).toBe(true);
    expect(report.valid).toBe(false);
    expect(report.missing.sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY']);
    // The formatter produces the message surfaced by `assertEnvSchemaValid`.
    const formatted = formatEnvReport(report);
    expect(formatted).toContain('STRIPE_KEY');
    expect(formatted).toContain('DATABASE_URL');
    expect(formatted).toContain('Missing required env vars');
  });

  it('treats remote secrets as "present" so a prod secret satisfies a required key', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });

    const { report } = await validateProdEnv(root, {
      productionOnly: true,
      remoteSecrets: ['STRIPE_KEY'],
    });

    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it('accepts remote secrets for non-string schemas (number/boolean/url) without running the validator against a placeholder', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });

    const { report } = await validateProdEnv(root, {
      productionOnly: true,
      remoteSecrets: ['PORT'],
    });

    expect(report.valid).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
  });

  it('never reads .env during production validation', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    writeDotenv(root, '.env', 'STRIPE_KEY=base\nPORT=3000\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing.sort()).toEqual(['PORT', 'STRIPE_KEY']);
  });

  it('reads only .env in local mode', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env', 'STRIPE_KEY=sk_dev\n');

    const { report } = await validateProdEnv(root, { productionOnly: false });

    expect(report.valid).toBe(true);
  });

  it('ignores server values from the production shell', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    vi.stubEnv('STRIPE_KEY', 'sk_live');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
  });

  it('validates client-prefixed values from the production shell', async () => {
    const root = createTempProject();
    defineEnv({ VITE_PORT: number() });
    vi.stubEnv('VITE_PORT', 'not-a-number');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.invalid.map((i) => i.key)).toEqual(['VITE_PORT']);
    const formatted = formatEnvReport(report);
    expect(formatted).toContain('Invalid env vars');
    expect(formatted).toContain('VITE_PORT');
  });

  it('redacts invalid client values in formatEnvReport', async () => {
    const root = createTempProject();
    defineEnv({ VITE_PORT: number() });
    vi.stubEnv('VITE_PORT', 'sk_live_abc123');

    const { report } = await validateProdEnv(root, { productionOnly: true });
    const formatted = formatEnvReport(report);
    expect(formatted).not.toContain('sk_live_abc123');
    expect(formatted).toContain('<redacted>');
    // Key name is still there so the user can find it.
    expect(formatted).toContain('VITE_PORT');
  });

  it('rejects reserved __VOID_ names in .env for a local check, with or without env.ts', async () => {
    for (const withEnvTs of [true, false]) {
      const root = createTempProject({ withEnvTs });
      writeDotenv(
        root,
        '.env',
        'API_URL=http://localhost\n__VOID_PROXY_TOKEN=x\n__VOID_EMAIL_FROM=y\n',
      );

      const error = await validateProdEnv(root, { productionOnly: false }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        '.env defines names reserved for Void: __VOID_PROXY_TOKEN, __VOID_EMAIL_FROM.',
      );
      expect((error as Error).message).toContain('Void sets these itself');
      expect((error as Error).message).toContain('x-void-dev-trigger header printed at dev start');
    }
  });

  it('rejects reserved names written as export K=v or K: v in .env', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(
      root,
      '.env',
      'API_URL=http://localhost\nexport __VOID_PROXY_TOKEN=x\n__VOID_EMAIL_FROM: a@b.c\n',
    );

    await expect(validateProdEnv(root, { productionOnly: false })).rejects.toThrow(
      '.env defines names reserved for Void: __VOID_PROXY_TOKEN, __VOID_EMAIL_FROM.',
    );
  });

  it('ignores __VOID_ in a .env comment or value', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env', '# __VOID_X=1\nAPI_URL=http://localhost/__VOID_X\n');

    await expect(validateProdEnv(root, { productionOnly: false })).resolves.toMatchObject({
      hasSchema: false,
    });
  });

  it('does not read .env names during production validation', async () => {
    const root = createTempProject({ withEnvTs: false });
    writeDotenv(root, '.env', '__VOID_PROXY_TOKEN=x\n');

    await expect(validateProdEnv(root, { productionOnly: true })).resolves.toMatchObject({
      hasSchema: false,
    });
  });

  it('ignores a reserved name set only in the shell', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env', 'STRIPE_KEY=sk_dev\n');
    vi.stubEnv('__VOID_PROXY_TOKEN', 'shell');

    const { report } = await validateProdEnv(root, { productionOnly: false });
    expect(report.valid).toBe(true);
  });

  it.each([false, true])(
    'rejects reserved __VOID_ names declared in env.ts (productionOnly: %s)',
    async (productionOnly) => {
      const root = createTempProject();
      defineEnv({ STRIPE_KEY: string(), __VOID_TOKEN: string().optional() });

      await expect(validateProdEnv(root, { productionOnly })).rejects.toThrow(
        'env.ts declares names reserved for Void: __VOID_TOKEN.',
      );
    },
  );
});
