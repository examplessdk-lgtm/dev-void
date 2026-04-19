import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatEnvReport, validateProdEnv } from '../../src/cli/env-validation';
import { number, string } from '../../src/runtime/env-helpers';
import { defineEnv } from '../../src/runtime/env-public';

/**
 * Integration coverage for the deploy-time env validation path. The
 * `assertEnvSchemaValid` wrapper inside `deploy.ts` is a thin layer over
 * `validateProdEnv` — it resolves the remote secret list, calls
 * `validateProdEnv`, and throws when the report is invalid. Exercising
 * `validateProdEnv` across the realistic source combinations (.env,
 * .env.production, .env.local, remote secrets) is what catches the
 * regressions that silently break `void deploy`.
 *
 * Schema registration is done directly via `defineEnv` rather than via an
 * `await import(envFile)` round-trip, because the fixture only needs
 * `findEnvFile` to return non-null for the schema-load branch to fire —
 * the actual schema is a process-wide singleton. An empty env.ts on disk
 * keeps the file-discovery contract honest.
 */

const roots: string[] = [];

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

afterEach(() => {
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

  it('reports missing required keys when neither .env* files nor remote secrets supply them', async () => {
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

  it('merges .env and .env.production values, with later files winning', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string(), PORT: number() });
    writeDotenv(root, '.env', 'STRIPE_KEY=base\nPORT=3000\n');
    // .env.production overrides PORT — deploy-safe.
    writeDotenv(root, '.env.production', 'PORT=8080\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(true);
  });

  it('does NOT read .env.local in productionOnly mode — .env.local must not plug prod gaps', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    // .env.local has the key — but productionOnly excludes it. This is the
    // guardrail that stops local-only secrets from masking a missing prod secret.
    writeDotenv(root, '.env.local', 'STRIPE_KEY=sk_dev\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(['STRIPE_KEY']);
  });

  it('reads .env.local in non-productionOnly mode (the `void env check` local path)', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env.local', 'STRIPE_KEY=sk_dev\n');

    const { report } = await validateProdEnv(root, { productionOnly: false });

    expect(report.valid).toBe(true);
  });

  it('surfaces invalid (not missing) values when a .env value fails schema validation', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });
    writeDotenv(root, '.env.production', 'PORT=not-a-number\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.invalid.map((i) => i.key)).toEqual(['PORT']);
    const formatted = formatEnvReport(report);
    expect(formatted).toContain('Invalid env vars');
    expect(formatted).toContain('PORT');
  });

  it('redacts invalid values in formatEnvReport when the value or key looks secret', async () => {
    const root = createTempProject();
    defineEnv({ PORT: number() });
    // `PORT=sk_live_abc123` is a "wrong-file typo" — the value itself is
    // secret-looking, so it must not surface in the CLI report.
    writeDotenv(root, '.env.production', 'PORT=sk_live_abc123\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });
    const formatted = formatEnvReport(report);
    expect(formatted).not.toContain('sk_live_abc123');
    expect(formatted).toContain('<redacted>');
    // Key name is still there so the user can find it.
    expect(formatted).toContain('PORT');
  });

  it('strips surrounding quotes in .env values so quoted prod secrets validate correctly', async () => {
    const root = createTempProject();
    defineEnv({ STRIPE_KEY: string() });
    writeDotenv(root, '.env.production', 'STRIPE_KEY="sk_live_abc"\n');

    const { report } = await validateProdEnv(root, { productionOnly: true });

    expect(report.valid).toBe(true);
  });
});
