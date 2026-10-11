import { PGlite } from '@electric-sql/pglite';
import {
  getPlatformRuntimeDirectory,
  platformDatabaseSchemaDigest,
  readPlatformRuntimeManifest,
  type PlatformRuntimeDatabaseManifest,
} from '@void/platform/installer';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  inspectPlatformDatabaseStateConnection,
  preparePlatformDatabaseConnection,
} from '../../src/cli/platform-installer-database.ts';

let database: PGlite | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('platform database migrations', () => {
  it('applies and recognizes the complete packaged PostgreSQL schema', async () => {
    database = new PGlite();
    await database.waitReady;
    const runtime = readPlatformRuntimeManifest();
    const connection = database as unknown as Parameters<
      typeof preparePlatformDatabaseConnection
    >[0];

    const migrated = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      runtime.database,
      null,
      false,
    );
    expect(migrated.appliedMigrations).toBe(runtime.database.migrations.length);
    expect(migrated.schemaDigest).toBe(runtime.database.schemaDigest);

    const state = await inspectPlatformDatabaseStateConnection(connection, runtime.database);
    expect(state).toEqual({
      pendingMigrations: [],
      schemaDigest: runtime.database.schemaDigest,
    });
    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        runtime.database,
        runtime.platformVersion,
        true,
      ),
    ).resolves.toEqual({
      appliedMigrations: 0,
      previousSchemaDigest: runtime.database.schemaDigest,
      schemaDigest: runtime.database.schemaDigest,
    });
  }, 30_000);

  it('applies an attested forward upgrade from an exact schema prefix', async () => {
    database = new PGlite();
    await database.waitReady;
    const runtime = readPlatformRuntimeManifest();
    const connection = database as unknown as Parameters<
      typeof preparePlatformDatabaseConnection
    >[0];
    const prefixMigrations = runtime.database.migrations.slice(0, 2);
    const prefixDigest = platformDatabaseSchemaDigest(runtime.database.lineage, prefixMigrations);
    const prefix = {
      ...runtime.database,
      migrations: prefixMigrations,
      rollbackSafeFrom: [],
      schemaDigest: prefixDigest,
    } satisfies PlatformRuntimeDatabaseManifest;
    await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      prefix,
      null,
      false,
    );
    const target = {
      ...runtime.database,
      rollbackSafeFrom: [{ platformVersion: '0.10.13', schemaDigest: prefixDigest }],
    } satisfies PlatformRuntimeDatabaseManifest;

    const migrated = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      target,
      '0.10.13',
      true,
    );

    expect(migrated.appliedMigrations).toBe(
      runtime.database.migrations.length - prefixMigrations.length,
    );
    expect(migrated.previousSchemaDigest).toBe(prefixDigest);
    expect(migrated.schemaDigest).toBe(runtime.database.schemaDigest);
  }, 30_000);
});
