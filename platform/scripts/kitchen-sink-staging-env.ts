import { fileURLToPath } from 'node:url';
import { PlatformApiError, PlatformClient } from '../../packages/void/src/cli/client.ts';
import { validateSecretValues } from '../../packages/void/src/cli/env-validation.ts';
import { initializeStagingEnv, STAGING_API } from './kitchen-sink-staging-env-setup.ts';

const projectRoot = fileURLToPath(new URL('../../playground/kitchen-sink', import.meta.url));

if (import.meta.main) {
  let step = 'checking staging credentials';
  try {
    if (
      process.env.VOID_API_URL !== STAGING_API ||
      !process.env.VOID_TOKEN ||
      !process.env.CF_ACCESS_CLIENT_ID ||
      !process.env.CF_ACCESS_CLIENT_SECRET
    ) {
      throw new Error('Explicit staging credentials and API URL are required.');
    }
    const client = new PlatformClient(process.env.VOID_TOKEN, { apiUrl: STAGING_API });
    const names = await initializeStagingEnv(
      client,
      (entries) => validateSecretValues(projectRoot, entries),
      (currentStep) => {
        step = currentStep;
      },
    );
    console.log(
      names.length > 0
        ? `Initialized staging kitchen-sink secrets: ${names.join(', ')}`
        : 'Staging kitchen-sink secrets are already configured.',
    );
  } catch (error) {
    // API errors can include response bodies. Never echo them or plaintext values.
    const status = error instanceof PlatformApiError ? ` (HTTP ${error.status})` : '';
    console.error(
      `Staging kitchen-sink fixture setup failed. Failed while ${step}${status}. Check the staging credentials, project access, and env.ts schema.`,
    );
    process.exitCode = 1;
  }
}
