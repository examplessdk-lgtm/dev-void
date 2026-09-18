import {
  PLATFORM_LOGIN_KINDS,
  parsePlatformLoginConfiguration,
  type PlatformLoginConfiguration,
} from '@void/platform';
import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { requireUncachedAuthenticationDatabase } from '../../auth/bootstrap.ts';
import {
  AuthenticationConfigurationError,
  importLegacyAuthentication,
} from '../../auth/configuration.ts';
import { createLoginTestLaunch } from '../../auth/login.ts';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import {
  authenticationActor,
  changeAuthenticationConnection,
  configureAuthenticationAdmission,
  configureAuthenticationConnection,
  getAuthenticationConfiguration,
} from '../../operator/auth-config.ts';
import { OperatorError } from '../../operator/common.ts';
import { platformLoginTests } from '../../schema.ts';
import { Layout } from '../views/layout.tsx';

const app = new Hono<ApiEnv>();
const HOME = '/admin/config/auth';
app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  await next();
});
app.onError((error, context) => {
  if (error instanceof OperatorError || error instanceof AuthenticationConfigurationError) {
    return context.html(
      <Layout title="Authentication settings" username={context.get('user')?.login}>
        <h1>Authentication settings</h1>
        <p>{error.message}</p>
        <p>
          <a href={HOME}>Return to settings</a> | <a href="/admin/logout">Sign in again</a>
        </p>
      </Layout>,
      error.status as ContentfulStatusCode,
    );
  }
  throw error;
});

function ConnectionForm({
  configuration,
  revision,
  callbackUrl,
}: {
  configuration: Partial<PlatformLoginConfiguration> & {
    id: string;
    kind: PlatformLoginConfiguration['kind'];
  };
  revision: number | null;
  callbackUrl: string;
}) {
  return (
    <form
      method="post"
      action={`${HOME}/connections/${encodeURIComponent(configuration.id)}/configure`}
      style="display: grid; gap: 12px; max-width: 700px"
    >
      <input type="hidden" name="id" value={configuration.id} />
      <input type="hidden" name="kind" value={configuration.kind} />
      <input type="hidden" name="revision" value={revision ?? ''} />
      <p>Register this callback URL with the provider:</p>
      <pre>{callbackUrl}</pre>
      <label>
        Connection ID{' '}
        <input
          name="connectionId"
          value={configuration.id}
          readonly={
            revision !== null || configuration.kind === 'github' || configuration.kind === 'google'
          }
          required
        />
      </label>
      <label>
        Login button label{' '}
        <input name="label" value={configuration.label ?? ''} required maxlength={100} />
      </label>
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <label>
          Issuer URL <input name="issuer" type="url" value={configuration.issuer ?? ''} required />
        </label>
      )}
      <label>
        Client ID <input name="clientId" value={configuration.clientId ?? ''} required />
      </label>
      <label>
        Client secret{' '}
        <input
          name="clientSecret"
          type="password"
          autocomplete="new-password"
          required={revision === null}
        />
      </label>
      {revision !== null && <p>Leave the secret blank to retain its saved value.</p>}
      {configuration.kind === 'google' && (
        <label>
          Allowed Workspace domains{' '}
          <input
            name="domains"
            value={configuration.allowedDomains?.join(', ') ?? ''}
            placeholder="example.com, example.org"
          />
          <small>
            {' '}
            Leave blank to allow any Google account to authenticate. Signup remains controlled
            separately.
          </small>
        </label>
      )}
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <label>
          Allowed groups{' '}
          <input name="groups" value={configuration.requiredGroups?.join(', ') ?? ''} />
          <small> Comma-separated; leave blank to use the provider's access policy.</small>
        </label>
      )}
      <p>Save a pending configuration, then test it before enabling it.</p>
      <button type="submit">Save configuration</button>
    </form>
  );
}

app.get('/', async (context) => {
  const data = await getAuthenticationConfiguration(context);
  const testId = context.req.query('test');
  const [tested] = testId
    ? await context
        .get('db')
        .select()
        .from(platformLoginTests)
        .where(
          and(
            eq(platformLoginTests.id, testId),
            eq(platformLoginTests.user_id, context.get('user').id),
            gt(platformLoginTests.expires_at, new Date().toISOString()),
          ),
        )
    : [];
  const admission = 'admission' in data ? data.admission : undefined;
  return context.html(
    <Layout title="Authentication settings" username={context.get('user').login}>
      <h1>Authentication settings</h1>
      <p>
        Platform protection:{' '}
        <strong>
          {data.protection ? 'Cloudflare Access enabled' : 'Cloudflare Access not enabled'}
        </strong>
        .
      </p>
      <p>Access protection and login methods are configured independently.</p>
      <details>
        <summary>Change platform protection</summary>
        <p>
          Use the installing CLI to create or connect a Cloudflare Access application, verify every
          platform origin, and sign in through the company policy. The CLI needs the installation's
          recovery credentials and separate Cloudflare Access setup permission.
        </p>
        <pre>void platform config auth protection enable --installation &lt;id&gt;</pre>
        <p>To remove protection, first change any signup policy that relies on Access, then run:</p>
        <pre>void platform config auth protection disable --installation &lt;id&gt;</pre>
        <p>
          Changes revoke existing human sessions. Access applications remain available for
          deliberate cleanup. Login methods and deployed applications keep their own settings.
        </p>
      </details>
      {!data.initialized ? (
        <form method="post" action={`${HOME}/initialize`}>
          <p>
            Initialize authentication settings to manage your existing login methods here. Their
            configuration is preserved; you will sign in again.
          </p>
          <button type="submit">Initialize settings</button>
        </form>
      ) : (
        <>
          {tested && (
            <section style="margin: 24px 0; padding: 16px; border: 1px solid #aaa">
              <h3>Login verified</h3>
              <p>
                Account: <strong>{tested.login || tested.subject}</strong>
              </p>
              <p>Provider: {tested.issuer}</p>
              <p>Identity: {tested.subject}</p>
              <p>
                Review this identity before linking it to your administrator account or enabling the
                tested configuration.
              </p>
              {(['link', 'enable'] as const).map((action) => (
                <form
                  key={action}
                  method="post"
                  action={`${HOME}/connections/${encodeURIComponent(tested.connection_id)}/${action}`}
                  style="display: inline-block; margin-right: 12px"
                >
                  <input type="hidden" name="revision" value={tested.revision} />
                  <input type="hidden" name="testId" value={tested.id} />
                  <button type="submit">
                    {action === 'link' ? 'Link to my account' : 'Enable tested configuration'}
                  </button>
                </form>
              ))}
            </section>
          )}
          <h2>Login methods</h2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.methods.map((method) => (
                <tr key={method.id}>
                  <td>{method.label}</td>
                  <td>
                    {method.enabled ? 'Enabled' : 'Disabled'}
                    {'activeRevision' in method && method.activeRevision !== method.revision
                      ? ' · Pending configuration'
                      : ''}
                  </td>
                  <td>
                    <a href={`${HOME}/connections/${encodeURIComponent(method.id)}`}>Edit</a>{' '}
                    <form
                      method="post"
                      action={`${HOME}/connections/${encodeURIComponent(method.id)}/test`}
                      style="display: inline"
                    >
                      <button type="submit">Test login</button>
                    </form>{' '}
                    {method.enabled && 'revision' in method && (
                      <form
                        method="post"
                        action={`${HOME}/connections/${encodeURIComponent(method.id)}/disable`}
                        style="display: inline"
                      >
                        <input type="hidden" name="revision" value={method.revision} />
                        <button type="submit">Disable and revoke sessions</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style="margin-top: 16px">
            Add:{' '}
            {PLATFORM_LOGIN_KINDS.map((kind) => (
              <>
                <a href={`${HOME}/new?kind=${kind}`}>
                  {kind === 'cloudflare-access'
                    ? 'Cloudflare Access'
                    : kind === 'oidc'
                      ? 'Generic OIDC'
                      : kind === 'github'
                        ? 'GitHub'
                        : 'Google'}
                </a>
                {' · '}
              </>
            ))}
          </p>
          <h2>Who can join?</h2>
          <form
            method="post"
            action={`${HOME}/admission`}
            style="display: grid; gap: 12px; max-width: 700px"
          >
            <input type="hidden" name="revision" value={'revision' in data ? data.revision : 0} />
            <select name="mode">
              <option value="restricted" selected={admission?.mode === 'restricted'}>
                Invited or allowlisted users
              </option>
              <option value="company" selected={admission?.mode === 'company'}>
                Company-approved users — automatic accounts
              </option>
              <option value="public" selected={admission?.mode === 'public'}>
                Public signup — all enabled logins
              </option>
            </select>
            <p>
              For company-approved signup, select the methods whose company policies qualify a new
              user:
            </p>
            {data.methods
              .filter((method) => method.enabled && method.kind !== 'github')
              .map((method) => (
                <label key={method.id}>
                  <input
                    type="checkbox"
                    name="connections"
                    value={method.id}
                    checked={
                      admission?.mode === 'company' && admission.connections.includes(method.id)
                    }
                  />{' '}
                  {method.label}
                </label>
              ))}
            {data.protection && (
              <label>
                <input
                  type="checkbox"
                  name="access"
                  value="true"
                  checked={admission?.mode === 'company' && admission.access}
                />{' '}
                Anyone who passes Cloudflare Access protection
              </label>
            )}
            <p>
              Automatically created accounts are ordinary users. Changing signup policy does not
              remove Access protection.
            </p>
            <button type="submit">Save signup policy</button>
          </form>
        </>
      )}
    </Layout>,
  );
});

app.get('/new', async (context) => {
  const kind = context.req.query('kind') as PlatformLoginConfiguration['kind'];
  if (!PLATFORM_LOGIN_KINDS.includes(kind)) {
    throw new OperatorError(400, 'Select a supported login method.');
  }
  const id = kind === 'oidc' ? 'company' : kind === 'cloudflare-access' ? 'access' : kind;
  return context.html(
    <Layout title="Add login method" username={context.get('user').login}>
      <h1>Add login method</h1>
      <ConnectionForm
        configuration={{
          id,
          kind,
          label:
            kind === 'oidc'
              ? 'Company SSO'
              : kind === 'cloudflare-access'
                ? 'Cloudflare Access'
                : kind === 'github'
                  ? 'GitHub'
                  : 'Google',
        }}
        revision={null}
        callbackUrl={
          context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href
        }
      />
    </Layout>,
  );
});
app.get('/connections/:id', async (context) => {
  const data = await getAuthenticationConfiguration(context);
  const method = data.methods.find((method) => method.id === context.req.param('id'));
  if (
    !method ||
    !('configuration' in method) ||
    !method.configuration ||
    !('revision' in method) ||
    typeof method.revision !== 'number'
  ) {
    throw new OperatorError(404, 'Login method not found.');
  }
  return context.html(
    <Layout title="Edit login method" username={context.get('user').login}>
      <h1>Edit {method.label}</h1>
      <ConnectionForm
        configuration={parsePlatformLoginConfiguration(method.configuration)}
        revision={method.revision}
        callbackUrl={
          context.env.AUTH_REDIRECT_URI ?? new URL('/auth/callback', context.req.url).href
        }
      />
    </Layout>,
  );
});
app.post('/initialize', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('config/auth/initialize'), async () => {
    requireUncachedAuthenticationDatabase(context.env);
    await importLegacyAuthentication(context.get('db'), context.env);
    deleteCookie(context, 'admin_token', { path: '/' });
    return { response: context.redirect('/admin/login'), succeeded: true };
  }),
);
app.post('/connections/:id/configure', async (context) => {
  const body = await context.req.parseBody();
  const revision = body.revision ? Number(body.revision) : null;
  const id = revision === null ? String(body.connectionId) : context.req.param('id');
  const action = `config/auth/connections/${id}/configure`;
  return executeAuditedMutation(context, operatorAuditIntent(action, { revision }), async () => {
    await configureAuthenticationConnection(context, id, {
      revision,
      configuration: {
        id,
        kind: String(body.kind),
        label: String(body.label),
        clientId: String(body.clientId),
        ...(body.issuer ? { issuer: String(body.issuer) } : {}),
        allowedDomains: String(body.domains ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        requiredGroups: String(body.groups ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      },
      ...(body.clientSecret ? { clientSecret: String(body.clientSecret) } : {}),
    });
    return { response: context.redirect(HOME), succeeded: true };
  });
});
app.post('/connections/:id/test', async (context) =>
  executeAuditedMutation(
    context,
    operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/test`),
    async () => {
      const launch = await createLoginTestLaunch(
        context,
        authenticationActor(context),
        context.req.param('id'),
      );
      return { response: context.redirect(launch.url), succeeded: true };
    },
  ),
);
for (const action of ['enable', 'disable', 'link'] as const) {
  app.post(`/connections/:id/${action}`, async (context) => {
    const form = await context.req.parseBody();
    const body = {
      revision: Number(form.revision),
      ...(form.testId ? { testId: String(form.testId) } : {}),
    };
    return executeAuditedMutation(
      context,
      operatorAuditIntent(`config/auth/connections/${context.req.param('id')}/${action}`, body),
      async () => {
        await changeAuthenticationConnection(context, context.req.param('id'), action, body);
        return {
          response: context.redirect(
            action === 'link' ? `${HOME}?test=${encodeURIComponent(body.testId!)}` : HOME,
          ),
          succeeded: true,
        };
      },
    );
  });
}
app.post('/admission', async (context) => {
  const form = await context.req.parseBody({ all: true });
  const connections = Array.isArray(form.connections)
    ? form.connections.map(String)
    : form.connections
      ? [String(form.connections)]
      : [];
  const body = {
    revision: Number(form.revision),
    admission: { mode: String(form.mode), connections, access: form.access === 'true' },
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('config/auth/admission', body),
    async () => {
      await configureAuthenticationAdmission(context, body);
      return { response: context.redirect(HOME), succeeded: true };
    },
  );
});
export default app;
