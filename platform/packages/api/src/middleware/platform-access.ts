import type { MiddlewareHandler } from 'hono';
import { platformAccessVerifier } from '../auth/access.ts';
import { readAuthSettings } from '../auth/configuration.ts';
import { verifyJwt } from '../auth/jwt.ts';
import type { ApiEnv } from '../env.ts';

/** These service-binding routes independently validate purpose-bound credentials. */
function internallyAuthenticated(method: string, path: string): boolean {
  return (
    ((method === 'GET' || method === 'POST') && path === '/email/destinations/confirm') ||
    (method === 'POST' &&
      (/^\/internal\/(?:resolve-resource|resolve-worker|verify-owner|verify-prerender-build)\/[^/]+$/.test(
        path,
      ) ||
        path === '/internal/revalidate' ||
        path === '/internal/email/domain-credential' ||
        path === '/internal/email/probe-ingress' ||
        path === '/internal/email/resolve-ingress' ||
        /^\/internal\/email\/actions\/(?:admit|receipts(?:\/(?:claim|complete))?|[^/]+\/(?:start|finish|status))$/.test(
          path,
        ) ||
        path === '/internal/github-webhook'))
  );
}

export const platformAccessProtection: MiddlewareHandler<ApiEnv> = async (context, next) => {
  const settings = await readAuthSettings(context.get('db'));
  if (settings && context.env.PLATFORM_AUTH_DATABASE_UNCACHED !== 'true') {
    return context.json(
      {
        error: 'auth_database_cache_enabled',
        message: 'Upgrade the platform to verify uncached authentication database reads.',
      },
      503,
    );
  }
  if (!settings?.protection) {
    if (settings?.admission.mode === 'company' && settings.admission.access) {
      return context.json({ error: 'company_protection_unavailable' }, 503);
    }
    return next();
  }
  // Runtime service-binding calls carry their own scoped credentials, not a human session.
  // Do not exempt a whole /internal prefix or an external installer health probe.
  if (internallyAuthenticated(context.req.method, context.req.path)) {
    return next();
  }
  try {
    const identity = await platformAccessVerifier.verify(
      context.req.url,
      context.req.header('Cf-Access-Jwt-Assertion'),
      settings.protection,
    );
    if (identity.kind === 'human') {
      context.set('companyIdentity', { issuer: identity.issuer, subject: identity.subject });
      return next();
    }
    const path = context.req.path;
    const method = context.req.method;
    const probe =
      context.env.PLATFORM_HEALTH_PROBE_TOKEN &&
      context.req.header('X-Void-Platform-Probe') === context.env.PLATFORM_HEALTH_PROBE_TOKEN;
    if (
      (path === '/.well-known/void-platform' && method === 'GET') ||
      (probe &&
        ((path === '/health' && method === 'GET') ||
          (path === '/internal/platform/sandbox-drain' && method === 'GET') ||
          (path === '/__void/platform/deployment-execution' && method === 'GET') ||
          (path === '/internal/platform/email-bootstrap' && method === 'POST') ||
          // The handler also requires its installation-specific setup HMAC.
          (path === '/internal/platform/app-access' && method === 'POST') ||
          (path === '/internal/platform/domain-preflight' && method === 'POST') ||
          (path === '/internal/platform/domain-activate' && method === 'POST')))
    ) {
      return next();
    }
    if (path === '/auth/github-oidc' && method === 'POST') {
      // The route additionally verifies GitHub's scoped workload identity.
      return next();
    }
    if (path === '/internal/platform/auth-initialize' && method === 'POST') {
      // This route also requires its own installation-specific setup HMAC, never a health token.
      return next();
    }
    if (path === '/projects' || path.startsWith('/projects/')) {
      const authorization = context.req.header('Authorization');
      const payload = authorization?.startsWith('Bearer ')
        ? await verifyJwt(authorization.slice(7), context.env.JWT_SECRET, 'deploy')
        : null;
      if (payload?.project) {
        // Normal API middleware still enforces the exact project/build/endpoint scope.
        return next();
      }
    }
    return context.json(
      {
        error: 'access_human_identity_required',
        message: 'This operation requires a company user identity, not an Access service token.',
      },
      403,
    );
  } catch {
    return context.json(
      {
        error: 'access_required',
        message: 'Authenticate through the configured Cloudflare Access application.',
      },
      403,
    );
  }
};
