import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vite-plus/test';
import { deployments, sandboxDrainCheckpoints } from '../../src/schema.ts';

const drizzleRoot = new URL('../../drizzle/', import.meta.url);

function readJson(path: URL): unknown {
  return JSON.parse(readFileSync(fileURLToPath(path), 'utf8')) as unknown;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('Sandbox drain database compatibility', () => {
  it('pins the verified 0036 baseline digest and keeps 0037 additive', () => {
    const compatibility = readJson(new URL('compatibility.json', drizzleRoot)) as {
      lineage: string;
    };
    const journal = readJson(new URL('meta/_journal.json', drizzleRoot)) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const baselineMigrations = journal.entries
      .filter((entry) => entry.idx <= 36)
      .map((entry) => ({
        index: entry.idx,
        sha256: sha256(readFileSync(new URL(`${entry.tag}.sql`, drizzleRoot))),
        tag: entry.tag,
        timestampMillis: entry.when,
      }));
    const baselineDigest = sha256(
      JSON.stringify({ lineage: compatibility.lineage, migrations: baselineMigrations }),
    );
    expect(baselineDigest).toBe('06c6f91f87d2ad95b1631ae48e2cd671aa6976fe53313947748c07bf2a7d6fda');

    const drainMigration = readFileSync(new URL('0037_unusual_bloodaxe.sql', drizzleRoot), 'utf8');
    const statements = drainMigration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE "sandbox_drain_checkpoints"/);
    expect(statements[1]).toMatch(/^CREATE INDEX "idx_deployments_created_id"/);
    expect(drainMigration).not.toMatch(/\b(?:ALTER|DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it('preserves the v2 barrier and defaults new deployments to protocol v3', () => {
    const admissionMigration = readFileSync(
      new URL('0038_deployment_admission_protocol.sql', drizzleRoot),
      'utf8',
    );
    expect(admissionMigration).toContain(
      'ALTER TABLE "deployments" ADD COLUMN "admission_protocol" integer DEFAULT 0 NOT NULL',
    );
    expect(admissionMigration).toContain(
      'ALTER TABLE "sandbox_drain_checkpoints" ADD COLUMN "admission_protocol" integer DEFAULT 0 NOT NULL',
    );
    expect(admissionMigration).toContain("'deployment-admission-bootstrap'");
    expect(admissionMigration).toContain(
      'COALESCE("required_protocol", 0) > NEW."admission_protocol"',
    );
    expect(admissionMigration).toMatch(/WHERE "singleton" = true\s+FOR SHARE/);
    expect(admissionMigration).toContain('BEFORE INSERT ON "deployments"');

    const deploymentAdmission = getTableConfig(deployments).columns.find(
      (column) => column.name === 'admission_protocol',
    );
    const checkpointAdmission = getTableConfig(sandboxDrainCheckpoints).columns.find(
      (column) => column.name === 'admission_protocol',
    );
    expect(deploymentAdmission?.default).toBe(0);
    expect(deploymentAdmission?.defaultFn?.()).toBe(3);
    expect(checkpointAdmission?.default).toBe(0);
  });
});
