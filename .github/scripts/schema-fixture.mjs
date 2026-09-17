import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve the driver from the checkout being tested, even when this script was
// saved in RUNNER_TEMP before Actions checked out another immutable revision.
const { Pool } = createRequire(
  pathToFileURL(`${process.cwd()}/platform/packages/api/package.json`),
)('pg');
const pool = new Pool({ connectionString: process.env.COMPAT_DATABASE_URL });
const snapshot =
  process.env.COMPAT_FIXTURE_PATH ??
  (process.env.RUNNER_TEMP ? `${process.env.RUNNER_TEMP}/void-schema-fixture.json` : undefined);
if (!snapshot || !process.env.COMPAT_DATABASE_URL) {
  throw new Error('A disposable compatibility database and fixture path are required.');
}
try {
  if (process.argv[2] === 'seed') {
    await pool.query(
      "INSERT INTO users (id, provider, provider_id, login, email, role, plan) VALUES ('user_compat', 'github', 'compat', 'compat', 'compat@example.invalid', 'admin', 'custom')",
    );
    await pool.query(
      "INSERT INTO projects (id, user_id, slug) VALUES ('proj_compat', 'user_compat', 'schema-compat-fixture')",
    );
    // Test-only key and nonce; match the platform's AES-GCM storage format.
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
    const ciphertext = Buffer.concat([
      cipher.update('schema compatibility fixture'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    await pool.query(
      "INSERT INTO project_secrets (id, project_id, name, ciphertext, iv, key_version) VALUES ('psc_compat', 'proj_compat', 'COMPAT_SECRET', $1, $2, '1')",
      [ciphertext, iv.toString('base64')],
    );
  } else if (process.argv[2] !== 'verify') {
    throw new Error('Use seed or verify.');
  }
  const rows = {};
  for (const [table, id] of [
    ['users', 'user_compat'],
    ['projects', 'proj_compat'],
    ['project_secrets', 'psc_compat'],
  ]) {
    const result = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    assert.equal(result.rows.length, 1, `${table}: upgrade lost the compatibility fixture`);
    rows[table] = JSON.parse(JSON.stringify(result.rows[0]));
  }
  if (process.argv[2] === 'seed') {
    writeFileSync(snapshot, JSON.stringify(rows), { mode: 0o600 });
  } else {
    const original = JSON.parse(readFileSync(snapshot, 'utf8'));
    for (const [table, row] of Object.entries(original)) {
      for (const [key, value] of Object.entries(row)) {
        assert.deepEqual(rows[table][key], value, `${table}.${key}: upgrade changed existing data`);
      }
    }
    console.log('Upgrade preserved the previous runtime user, project, and encrypted secret.');
  }
} finally {
  await pool.end();
}
