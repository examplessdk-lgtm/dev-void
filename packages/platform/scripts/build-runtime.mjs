import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = join(packageRoot, '..', '..');
const runtimeRoot = join(packageRoot, 'dist', 'runtime');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'void-platform-runtime-'));
const wrangler = fileURLToPath(import.meta.resolve('wrangler'));
const drizzleRoot = join(repositoryRoot, 'platform', 'packages', 'api', 'drizzle');
const { parsePlatformRuntimeManifest, platformDatabaseSchemaDigest } = await import(
  pathToFileURL(join(packageRoot, 'dist', 'installer.mjs')).href
);

const workers = [
  ['api', join(repositoryRoot, 'platform', 'packages', 'api', 'src', 'index.ts')],
  ['proxy', join(repositoryRoot, 'platform', 'packages', 'proxy', 'src', 'index.ts')],
  ['tail', join(repositoryRoot, 'platform', 'packages', 'tail', 'src', 'index.ts')],
  ['dispatch', join(repositoryRoot, 'platform', 'packages', 'dispatch', 'src', 'index.ts')],
];
const sourceAliases = {
  '@void/deploy-core': join(repositoryRoot, 'packages', 'deploy-core', 'src', 'index.ts'),
  '@void/edge': join(repositoryRoot, 'packages', 'edge', 'src', 'index.ts'),
  '@void/isr': join(repositoryRoot, 'packages', 'isr', 'src', 'index.ts'),
  '@void/isr/core': join(repositoryRoot, 'packages', 'isr', 'src', 'core.ts'),
};

try {
  rmSync(runtimeRoot, { force: true, recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const artifacts = {};

  for (const [name, entrypoint] of workers) {
    const configPath = join(temporaryRoot, `${name}.json`);
    const outputDirectory = join(runtimeRoot, name);
    writeFileSync(
      configPath,
      JSON.stringify({
        name: `void-runtime-build-${name}`,
        main: entrypoint,
        alias: sourceAliases,
        compatibility_date: '2026-02-24',
        compatibility_flags: name === 'api' || name === 'proxy' ? ['nodejs_compat'] : [],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [wrangler, 'deploy', '--dry-run', '--config', configPath, '--outdir', outputDirectory],
      { cwd: dirname(entrypoint), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`Failed to build the ${name} platform Worker.`);
    }
    const artifactPath = join(outputDirectory, 'index.js');
    const contents = readFileSync(artifactPath);
    artifacts[name] = {
      path: `${name}/index.js`,
      sha256: createHash('sha256').update(contents).digest('hex'),
      size: contents.byteLength,
    };
  }

  cpSync(drizzleRoot, join(runtimeRoot, 'drizzle'), { recursive: true });
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const database = buildDatabaseManifest();
  const manifest = parsePlatformRuntimeManifest({
    artifacts,
    database,
    platformVersion: packageJson.version,
    schemaVersion: 2,
    sourceRevision: process.env.VOID_PLATFORM_SOURCE_REVISION || null,
  });
  writeFileSync(join(runtimeRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function buildDatabaseManifest() {
  const journalPath = join(drizzleRoot, 'meta', '_journal.json');
  const journalContents = readFileSync(journalPath);
  const journal = parseObjectJson(journalContents, journalPath);
  if (journal.dialect !== 'postgresql') {
    throw new Error('Void Platform migrations must use the PostgreSQL dialect.');
  }
  if (!Array.isArray(journal.entries)) {
    throw new Error('Void Platform migration journal entries must be an array.');
  }
  const compatibilityPath = join(drizzleRoot, 'compatibility.json');
  const compatibility = parseObjectJson(readFileSync(compatibilityPath), compatibilityPath);
  if (compatibility.schemaVersion !== 1) {
    throw new Error('Void Platform database compatibility schemaVersion must be 1.');
  }
  if (typeof compatibility.lineage !== 'string' || compatibility.lineage.trim() === '') {
    throw new Error('Void Platform database compatibility lineage must be a non-empty string.');
  }
  if (!Array.isArray(compatibility.rollbackSafeFrom)) {
    throw new Error('Void Platform rollbackSafeFrom must be an array.');
  }
  const migrations = journal.entries.map((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Void Platform migration journal entry ${position} must be an object.`);
    }
    const { idx, tag, when } = value;
    if (!Number.isSafeInteger(idx) || idx < 0) {
      throw new Error(`Void Platform migration journal entry ${position} has an invalid index.`);
    }
    if (typeof tag !== 'string' || !/^[0-9]{4}_[a-z0-9_]+$/.test(tag)) {
      throw new Error(`Void Platform migration journal entry ${position} has an invalid tag.`);
    }
    if (!Number.isSafeInteger(when) || when < 0) {
      throw new Error(
        `Void Platform migration journal entry ${position} has an invalid timestamp.`,
      );
    }
    const sqlPath = join(drizzleRoot, `${tag}.sql`);
    let sql;
    try {
      sql = readFileSync(sqlPath);
    } catch (error) {
      throw new Error(
        `Void Platform migration ${tag} is missing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      index: idx,
      sha256: sha256(sql),
      tag,
      timestampMillis: when,
    };
  });
  for (let index = 0; index < migrations.length; index++) {
    const migration = migrations[index];
    const previous = migrations[index - 1];
    if (
      migrations.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          (candidate.index === migration.index ||
            candidate.tag === migration.tag ||
            candidate.timestampMillis === migration.timestampMillis),
      )
    ) {
      throw new Error('Void Platform migration journal entries must be unique.');
    }
    if (
      previous &&
      (migration.index <= previous.index || migration.timestampMillis <= previous.timestampMillis)
    ) {
      throw new Error('Void Platform migration journal entries must be strictly ordered.');
    }
  }
  const prefixDigests = new Set(
    Array.from({ length: migrations.length + 1 }, (_, length) =>
      platformDatabaseSchemaDigest(compatibility.lineage, migrations.slice(0, length)),
    ),
  );
  const rollbackSafeFrom = compatibility.rollbackSafeFrom.map((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Void Platform compatibility entry ${position} must be an object.`);
    }
    const { platformVersion, schemaDigest } = value;
    if (typeof platformVersion !== 'string' || platformVersion.trim() === '') {
      throw new Error(`Void Platform compatibility entry ${position} has an invalid version.`);
    }
    if (typeof schemaDigest !== 'string' || !/^[0-9a-f]{64}$/.test(schemaDigest)) {
      throw new Error(`Void Platform compatibility entry ${position} has an invalid digest.`);
    }
    if (!prefixDigests.has(schemaDigest)) {
      throw new Error(
        `Void Platform compatibility entry ${position} references a schema outside this migration lineage.`,
      );
    }
    return { platformVersion, schemaDigest };
  });
  const keys = rollbackSafeFrom.map(
    ({ platformVersion, schemaDigest }) => `${platformVersion}\0${schemaDigest}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new Error('Void Platform compatibility entries must be unique.');
  }
  return {
    journalSha256: sha256(journalContents),
    lineage: compatibility.lineage,
    migrations,
    protocolVersion: 1,
    rollbackSafeFrom,
    schemaDigest: platformDatabaseSchemaDigest(compatibility.lineage, migrations),
  };
}

function parseObjectJson(contents, path) {
  let value;
  try {
    value = JSON.parse(contents.toString('utf8'));
  } catch (error) {
    throw new Error(
      `Void Platform metadata is invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Void Platform metadata at ${path} must be an object.`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
