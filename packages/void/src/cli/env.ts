import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { intro, outro, log, note } from '@clack/prompts';
import { findEnvFile, generateEnvTypes } from '../codegen/env-types';
import { getToken } from './auth';
import { PlatformClient } from './client';
import type { EnvArgs } from './env-args';
import { fetchRemoteSecretNames, formatEnvReport, validateProdEnv } from './env-validation';
import { cliTitle } from './output';
import { readProjectConfig } from './project';

export async function runEnvCommand(root: string, args: EnvArgs): Promise<void> {
  console.log();
  intro(cliTitle(`env ${args.subcommand}`));

  if (args.subcommand === 'check') {
    await runCheck(root, args.useRemoteSecrets);
    return;
  }
  if (args.subcommand === 'types') {
    runTypes(root);
    return;
  }
}

async function runCheck(root: string, useRemoteSecrets: boolean): Promise<void> {
  let remoteSecrets: string[] | undefined;
  if (useRemoteSecrets) {
    const token = getToken(root);
    if (!token) {
      log.error('--remote requires authentication. Run `void auth login` first.');
      process.exit(1);
    }
    const config = readProjectConfig(root);
    if (!config) {
      log.error('--remote requires a linked project. Run `void project link` first.');
      process.exit(1);
    }
    const client = new PlatformClient(token, { root });
    remoteSecrets = await fetchRemoteSecretNames(client, config.projectId);
  }

  const { hasSchema, report } = await validateProdEnv(root, {
    productionOnly: true,
    remoteSecrets,
  });

  if (!hasSchema) {
    outro('No env.ts found — nothing to validate.');
    return;
  }
  if (report.valid) {
    outro('All required env vars are present and valid.');
    return;
  }

  note(formatEnvReport(report), 'Env validation failed');
  if (report.missing.length > 0) {
    log.info(
      `Set missing values via .env / .env.production, or upload as secrets with \`void secret put <NAME>\`.`,
    );
  }
  process.exit(1);
}

function runTypes(root: string): void {
  const envFile = findEnvFile(root);
  if (!envFile) {
    outro('No env.ts found at project root — nothing to generate.');
    return;
  }
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  const { dts } = generateEnvTypes(envFile, outDir);
  writeFileSync(join(outDir, 'env.d.ts'), dts);
  outro(`Wrote ${join('.void', 'env.d.ts')}.`);
}
