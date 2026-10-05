import { mkdirSync, writeFileSync } from 'node:fs';
import { outro, log } from '@voidzero-dev/vite-plus-prompts';
import { join } from 'pathslash';
import { findEnvFile, generateEnvTypes } from '../codegen/env-types.ts';
import { getToken } from './auth.ts';
import { PlatformClient } from './client.ts';
import type { EnvArgs } from './env-args.ts';
import { fetchRemoteSecretNames, formatEnvReport, validateProdEnv } from './env-validation.ts';
import { note } from './output.ts';
import { readDeploymentPlatform, readProjectConfig } from './project.ts';

export async function runEnvCommand(root: string, args: EnvArgs): Promise<void> {
  console.log();

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
  let remoteSecrets: Array<string> | undefined;
  if (useRemoteSecrets) {
    const platform = readDeploymentPlatform(root);
    if (platform === 'none') {
      throw new Error('env: Deployment is disabled. Run `void init` to choose a platform.');
    }
    if (platform === 'cloudflare') {
      const { listCloudflareSecrets, resolveCloudflareOperationContext } =
        await import('./cloudflare-operations.ts');
      remoteSecrets = await listCloudflareSecrets(resolveCloudflareOperationContext(root));
    } else {
      const token = getToken(root);
      if (!token) {
        log.error('--remote requires authentication. Run `void account login` first.');
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
  }

  const { hasSchema, report } = await validateProdEnv(root, {
    productionOnly: useRemoteSecrets,
    remoteSecrets,
  });

  if (!hasSchema) {
    outro('No env.ts found — nothing to validate.');
    return;
  }
  if (report.valid) {
    outro(
      useRemoteSecrets
        ? 'All required remote env names are present; values validate at runtime.'
        : 'Local .env values are valid.',
    );
    return;
  }

  note(formatEnvReport(report), 'Env validation failed');
  if (report.missing.length > 0) {
    log.info(
      useRemoteSecrets
        ? 'Upload missing server values with `void secret put <NAME>`; set VITE_* values in the build shell or schema defaults.'
        : 'Add the missing values to .env or set them in your shell.',
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
