import { parsePlatformAuthenticationSetup } from '@void/platform';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { platformAccessVerifier } from '../auth/access.ts';
import {
  AUTH_SETUP_PROOF_PREFIX,
  confirmBootstrapIdentity,
  initializeAuthentication,
  isCompletedAuthenticationSetupReplay,
  pendingAuthenticationSetup,
} from '../auth/bootstrap.ts';
import { AuthenticationConfigurationError, readLoginRevision } from '../auth/configuration.ts';
import { hmacVerifyState } from '../auth/hmac.ts';
import { startBootstrapLogin } from '../auth/login.ts';
import { escapeHtml } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { getPlatformPageTitle } from '../platform-identity.ts';

const app = new Hono<ApiEnv>();
const noStore: MiddlewareHandler<ApiEnv> = async (context, next) => {
  context.header('Cache-Control', 'no-store');
  // Native form submissions need their same-origin Origin header. no-referrer
  // serializes that header as null, while strict-origin hides paths and codes.
  context.header(
    'Referrer-Policy',
    context.req.path === '/setup' ? 'strict-origin' : 'no-referrer',
  );
  await next();
};
for (const path of [
  '/setup',
  '/auth/bootstrap',
  '/auth/bootstrap/*',
  '/internal/platform/auth-initialize',
]) {
  app.use(path, noStore);
}
app.onError((error, context) => {
  if (error instanceof AuthenticationConfigurationError) {
    return context.json(
      { error: error.code, message: error.message },
      error.status as ContentfulStatusCode,
    );
  }
  return context.json(
    {
      error: 'setup_failed',
      message: 'Platform administrator setup failed. Resume setup from the installing CLI.',
    },
    500,
  );
});

app.post(
  '/internal/platform/auth-initialize',
  bodyLimit({ maxSize: 256 * 1024 }),
  async (context) => {
    const secret = context.env.PLATFORM_AUTH_SETUP_TOKEN;
    const installationId = context.env.PLATFORM_INSTALLATION_ID;
    if (!secret || !installationId) {
      return context.json({ error: 'not_found' }, 404);
    }
    const signature = context.req.header('X-Void-Auth-Setup');
    if (!signature || context.req.header('Content-Type')?.split(';')[0] !== 'application/json') {
      return context.json({ error: 'setup_authority_required' }, 403);
    }
    const body = await context.req.text();
    if (
      !(await hmacVerifyState(
        `${AUTH_SETUP_PROOF_PREFIX}\n${installationId}\n${body}`,
        signature,
        secret,
      ))
    ) {
      return context.json({ error: 'invalid_setup_authority' }, 403);
    }
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return context.json({ error: 'invalid_setup_body' }, 400);
    }
    let setup;
    try {
      setup = parsePlatformAuthenticationSetup(input);
    } catch {
      return context.json(
        { error: 'invalid_setup_body', message: 'Verify the authentication setup fields.' },
        400,
      );
    }
    const completedReplay = await isCompletedAuthenticationSetupReplay(context.get('db'), setup);
    if (setup.protection && !completedReplay) {
      try {
        await platformAccessVerifier.verify(
          context.req.url,
          context.req.header('Cf-Access-Jwt-Assertion'),
          setup.protection,
        );
      } catch {
        return context.json(
          {
            error: 'access_verification_required',
            message:
              'Verify Access protection for the setup request before initializing authentication.',
          },
          403,
        );
      }
    }
    return context.json(
      await initializeAuthentication(
        context.get('db'),
        context.env,
        setup,
        new URL(context.req.url).origin,
      ),
    );
  },
);

app.get('/setup', async (context) => {
  const pending = await pendingAuthenticationSetup(context.get('db'));
  if (!pending) {
    return context.redirect('/admin/login');
  }
  const revision = await readLoginRevision(context.get('db'), pending.connection_id, 1);
  if (Date.parse(pending.expires_at) <= Date.now()) {
    return context.html(
      '<!doctype html><title>' +
        escapeHtml(getPlatformPageTitle('Setup code expired', context.env, context.req.url)) +
        '</title><h1>Setup code expired</h1><p>Run <code>void platform repair ' +
        escapeHtml(pending.installation_id) +
        '</code> from the installing computer to generate a new code. If installation was interrupted, resume the original install command instead.</p>',
      410,
    );
  }
  return context.html(
    '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
      escapeHtml(getPlatformPageTitle('Set up administrator', context.env, context.req.url)) +
      '</title>' +
      '<main style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:1rem"><h1>Set up your platform administrator</h1>' +
      '<p>Enter the setup code printed by the installer. You will sign in and review the account before it becomes the first administrator.</p>' +
      '<form method="post" action="/auth/bootstrap"><label>Setup code <input name="code" type="password" autocomplete="one-time-code" required></label>' +
      '<button type="submit">Continue with ' +
      escapeHtml(revision?.configuration.label ?? pending.connection_id) +
      '</button></form></main>',
  );
});

app.post('/auth/bootstrap', bodyLimit({ maxSize: 4096 }), async (context) => {
  if (context.req.header('Origin') !== new URL(context.req.url).origin) {
    return context.json({ error: 'invalid_origin' }, 403);
  }
  const body = await context.req.parseBody();
  return startBootstrapLogin(context, typeof body.code === 'string' ? body.code.trim() : '');
});
app.post('/auth/bootstrap/confirm', bodyLimit({ maxSize: 4096 }), async (context) => {
  if (context.req.header('Origin') !== new URL(context.req.url).origin) {
    return context.json({ error: 'invalid_origin' }, 403);
  }
  const body = await context.req.parseBody();
  if (body.confirm !== 'yes') {
    return context.json({ error: 'confirmation_required' }, 400);
  }
  const proof = getCookie(context, 'void_bootstrap_confirm') ?? '';
  const result = await confirmBootstrapIdentity(
    context.get('db'),
    context.env,
    proof,
    context.get('companyIdentity'),
  );
  deleteCookie(context, 'void_bootstrap_confirm', { path: '/auth/bootstrap/confirm' });
  setCookie(context, 'admin_token', result.token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(0, Math.floor((Date.parse(result.session.expires_at) - Date.now()) / 1000)),
  });
  return context.redirect('/admin/');
});
export default app;
