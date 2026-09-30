import type { Context } from 'hono';
import type { ApiEnv } from './env.ts';
import {
  parseZeroTrustApplicationTarget,
  ZeroTrustConfigurationError,
} from './zero-trust/configuration.ts';
import { ZeroTrustUnavailableError } from './zero-trust/errors.ts';
import { activatePlatformApplication } from './zero-trust/installation.ts';

/** Final installer handoff; only the service may publish application routing. */
export async function platformDomainActivation(context: Context<ApiEnv>): Promise<Response> {
  const token = context.env.PLATFORM_HEALTH_PROBE_TOKEN;
  if (
    !token ||
    context.req.header('X-Void-Platform-Probe') !== token ||
    !context.env.PLATFORM_APPLICATION ||
    !context.env.PLATFORM_INSTALLATION_ID
  ) {
    return context.json({ error: 'not found' }, 404);
  }
  let target;
  try {
    const body = await context.req.json<{ application: unknown }>();
    target = parseZeroTrustApplicationTarget(body.application);
  } catch {
    return context.json({ error: 'Invalid application domain target.' }, 400);
  }
  try {
    const result = await activatePlatformApplication(context.env, context.get('db'), target);
    return context.json(
      { ok: true, installationId: context.env.PLATFORM_INSTALLATION_ID, ...result },
      result.ready ? 200 : 202,
    );
  } catch (error) {
    if (
      error instanceof ZeroTrustConfigurationError ||
      error instanceof ZeroTrustUnavailableError
    ) {
      return context.json({ error: error.message }, 409);
    }
    console.error('[platform] application domain activation failed', error);
    return context.json(
      { error: 'Application domain protection is not ready. Retry domain setup.' },
      503,
    );
  }
}
