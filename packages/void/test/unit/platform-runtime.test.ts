import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  it('binds every packaged migration and Worker artifact to the manifest', () => {
    const runtimeDirectory = getPlatformRuntimeDirectory();
    const manifest = readPlatformRuntimeManifest();

    expect(manifest.schemaVersion).toBe(2);
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
