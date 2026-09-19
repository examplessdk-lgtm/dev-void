import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getPlatformRuntimeDirectory,
  parsePlatformRuntimeManifest,
  platformDatabaseSchemaDigest,
  readPlatformRuntimeManifest,
  resolvePlatformRuntime,
} from '@void/platform/installer';
import { join } from 'pathslash';
import { describe, expect, it } from 'vite-plus/test';
import { loadPlatformRuntime } from '../../src/cli/platform-installer.ts';

describe('platform runtime manifest', () => {
  it('packages migration inputs without Drizzle authoring snapshots', () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const manifest = readPlatformRuntimeManifest();
    const migrationsDirectory = join(runtimeDirectory, 'drizzle');

    expect(readdirSync(migrationsDirectory).sort()).toEqual(
      [
        'compatibility.json',
        'meta',
        ...manifest.database.migrations.map((migration) => `${migration.tag}.sql`),
      ].sort(),
    );
    expect(readdirSync(join(migrationsDirectory, 'meta'))).toEqual(['_journal.json']);
    const compatibility = JSON.parse(
      readFileSync(join(migrationsDirectory, 'compatibility.json'), 'utf8'),
    );
    expect(compatibility.lineage).toBe(manifest.database.lineage);
    expect(compatibility.rollbackSafeFrom).toEqual(manifest.database.rollbackSafeFrom);
  });

  it('binds every packaged migration and Worker artifact to the manifest', () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const manifest = readPlatformRuntimeManifest();

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.safetyProtocols).toEqual({ sandboxDrain: 2 });
    expect(manifest.usageProtocolVersion).toBe(1);
    expect(manifest.database.schemaDigest).toBe(
      platformDatabaseSchemaDigest(manifest.database.lineage, manifest.database.migrations),
    );
    expect(manifest.database.migrations.length).toBeGreaterThan(0);
    for (const migration of manifest.database.migrations) {
      expect(digest(readFileSync(join(runtimeDirectory, 'drizzle', `${migration.tag}.sql`)))).toBe(
        migration.sha256,
      );
    }
    expect(digest(readFileSync(join(runtimeDirectory, 'drizzle', 'meta', '_journal.json')))).toBe(
      manifest.database.journalSha256,
    );
    for (const artifact of Object.values(manifest.artifacts)) {
      const contents = readFileSync(join(runtimeDirectory, artifact.path));
      expect(contents.byteLength).toBe(artifact.size);
      expect(digest(contents)).toBe(artifact.sha256);
    }
  });

  it('rejects malformed and internally inconsistent manifests', () => {
    const manifest = readPlatformRuntimeManifest();

    expect(() => parsePlatformRuntimeManifest({ ...manifest, schemaVersion: 1 })).toThrow(
      'schemaVersion must be 2',
    );
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        database: { ...manifest.database, schemaDigest: '0'.repeat(64) },
      }),
    ).toThrow('schema digest does not match');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          api: { ...manifest.artifacts.api, path: '../api.js' },
        },
      }),
    ).toThrow('must stay inside the package');
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        database: {
          ...manifest.database,
          rollbackSafeFrom: [
            manifest.database.rollbackSafeFrom[0],
            manifest.database.rollbackSafeFrom[0],
          ],
        },
      }),
    ).toThrow('compatibility entries must be unique');
    expect(() =>
      parsePlatformRuntimeManifest({ ...manifest, sourceRevision: 'revision with spaces' }),
    ).toThrow('sourceRevision is invalid');
    expect(() => parsePlatformRuntimeManifest({ ...manifest, usageProtocolVersion: 2 })).toThrow(
      'usageProtocolVersion must be 0 or 1',
    );
    expect(() =>
      parsePlatformRuntimeManifest({
        ...manifest,
        safetyProtocols: { sandboxDrain: 3 },
      }),
    ).toThrow('safetyProtocols.sandboxDrain must be 0, 1, or 2');
    const { usageProtocolVersion: _usageProtocolVersion, ...legacy } = manifest;
    expect(parsePlatformRuntimeManifest(legacy).usageProtocolVersion).toBe(0);
    const { safetyProtocols: _safetyProtocols, ...legacySafety } = manifest;
    expect(parsePlatformRuntimeManifest(legacySafety).safetyProtocols).toEqual({ sandboxDrain: 0 });
    const { emailGateway: _gateway, ...fourArtifacts } = manifest.artifacts;
    const { emailProtocolVersion: _emailProtocolVersion, ...preEmailRuntime } = manifest;
    expect(() => parsePlatformRuntimeManifest(preEmailRuntime)).toThrow(
      'An emailGateway runtime artifact requires email protocol version 1',
    );
    expect(
      parsePlatformRuntimeManifest({
        ...preEmailRuntime,
        artifacts: fourArtifacts,
      }).artifacts.emailGateway,
    ).toBeUndefined();
    expect(() => parsePlatformRuntimeManifest({ ...manifest, artifacts: fourArtifacts })).toThrow(
      'Email protocol version 1 requires an emailGateway runtime artifact',
    );
  });

  it('resolves packaged and explicit runtime directories with provenance', () => {
    const packaged = resolvePlatformRuntime();
    const custom = resolvePlatformRuntime(getPlatformRuntimeDirectory());

    expect(packaged.source).toBe('package');
    expect(custom.source).toBe('custom');
    expect(custom.directory).toBe(packaged.directory);
    expect(custom.manifest).toEqual(packaged.manifest);
    expect(custom.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(custom.manifestSha256).toBe(packaged.manifestSha256);
    expect(() => resolvePlatformRuntime('does-not-exist')).toThrow(
      'runtime directory is unavailable',
    );
  });

  it('starts the packaged API Worker in the bundled local runtime', async () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const runtime = readPlatformRuntimeManifest();
    const apiPackagePath = fileURLToPath(
      new URL('../../../../platform/packages/api/package.json', import.meta.url),
    );
    const apiRequire = createRequire(apiPackagePath);
    const miniflarePath = createRequire(apiRequire.resolve('wrangler')).resolve('miniflare');
    const { Miniflare, convertV4MiniflareOptions } = (await import(
      pathToFileURL(miniflarePath).href
    )) as MiniflareModule;
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        bindings: { PLATFORM_TRAFFIC_STATE: 'staging' },
        compatibilityDate: '2026-02-24',
        compatibilityFlags: ['nodejs_compat'],
        modules: true,
        scriptPath: join(runtimeDirectory, runtime.artifacts.api.path),
      }),
    );

    try {
      await miniflare.ready;
      expect((await miniflare.dispatchFetch('http://localhost/health')).status).toBe(503);
    } finally {
      await miniflare.dispose();
    }
  });

  it('rejects a custom runtime whose artifacts changed after its manifest was built', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'void-custom-runtime-test-'));
    const runtimeDirectory = join(temporary, 'runtime');
    try {
      cpSync(getPlatformRuntimeDirectory(), runtimeDirectory, { recursive: true });
      const runtime = loadPlatformRuntime(runtimeDirectory);
      const apiPath = join(runtimeDirectory, runtime.manifest.artifacts.api.path);
      writeFileSync(apiPath, `${readFileSync(apiPath, 'utf8')}\n// changed\n`);

      expect(() => loadPlatformRuntime(runtimeDirectory)).toThrow('integrity verification');
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });
});

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

type MiniflareModule = Readonly<{
  Miniflare: new (options: Record<string, unknown>) => {
    readonly ready: Promise<URL>;
    dispatchFetch(url: string): Promise<Response>;
    dispose(): Promise<void>;
  };
  convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>;
}>;
