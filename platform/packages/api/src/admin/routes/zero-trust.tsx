import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import {
  ZeroTrustConfigurationError,
  normalizeZeroTrustConfigureInput,
} from '../../zero-trust/configuration.ts';
import {
  configurePlatformZeroTrust,
  disablePlatformZeroTrust,
  reconcilePlatformZeroTrust,
  ZeroTrustUnavailableError,
  zeroTrustStatus,
} from '../../zero-trust/service.ts';
import { renderOperationError } from '../operation-error.tsx';
// TODO(zt-admin-port): port the GET page to the React admin; views/layout.tsx was removed.
import { Layout } from '../views/layout.tsx';

const app = new Hono<ApiEnv>();
app.use('*', async (context, next) => {
  context.header('Cache-Control', 'no-store');
  context.header('Referrer-Policy', 'no-referrer');
  await next();
});
app.onError(renderOperationError);

function values(value: FormDataEntryValue | undefined): ReadonlyArray<string> {
  return typeof value === 'string'
    ? value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function adminError(error: unknown): never {
  if (error instanceof ZeroTrustConfigurationError) {
    throw new OperatorError(400, error.message, 'invalid_zero_trust_configuration');
  }
  if (error instanceof ZeroTrustUnavailableError) {
    throw new OperatorError(error.status, error.message, 'zero_trust_unavailable');
  }
  console.error('[zero-trust] admin operation failed', error);
  throw new OperatorError(
    502,
    'Cloudflare Zero Trust reconciliation failed. Review the saved status and retry.',
    'zero_trust_reconciliation_failed',
  );
}

app.get('/', async (context) => {
  const status = await zeroTrustStatus(context.env, context.get('db'));
  return context.html(
    <Layout title="Project Zero Trust" username={context.get('user').login}>
      <h1>Project Zero Trust</h1>
      <p>
        Void manages a wildcard Cloudflare Access application for protected projects and exact-host
        bypass applications for public exceptions. Credentials are encrypted and never returned.
      </p>

      <h2>Status</h2>
      <table>
        <tbody>
          <tr>
            <th>Configured</th>
            <td>{status.configured ? 'Yes' : 'No'}</td>
          </tr>
          <tr>
            <th>Enabled</th>
            <td>{status.enabled ? 'Yes' : 'No'}</td>
          </tr>
          {'status' in status && (
            <tr>
              <th>Reconciliation</th>
              <td>{String(status.status)}</td>
            </tr>
          )}
          {'operation' in status && status.operation && (
            <tr>
              <th>Current operation</th>
              <td>
                {status.operation.kind} · {status.operation.phase}
              </td>
            </tr>
          )}
          {'accountId' in status && (
            <tr>
              <th>Cloudflare account</th>
              <td>{String(status.accountId)}</td>
            </tr>
          )}
          {'teamDomain' in status && (
            <tr>
              <th>Access team domain</th>
              <td>{String(status.teamDomain)}</td>
            </tr>
          )}
          {'protectNewProjects' in status && (
            <tr>
              <th>Protect new projects</th>
              <td>{status.protectNewProjects ? 'Yes' : 'No'}</td>
            </tr>
          )}
          <tr>
            <th>Live application</th>
            <td>
              {status.live
                ? status.live.present && !status.live.drifted
                  ? 'Healthy'
                  : 'Missing or drifted'
                : 'Not active'}
            </td>
          </tr>
          {'lastError' in status && status.lastError && (
            <tr>
              <th>Last error</th>
              <td>{String(status.lastError)}</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>Project states</h3>
      {status.projects.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Desired</th>
              <th>Effective</th>
              <th>State</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {status.projects.map((entry) => (
              <tr key={`${entry.desiredProtected}:${entry.effectiveProtected}:${entry.state}`}>
                <td>{entry.desiredProtected ? 'protected' : 'public'}</td>
                <td>{entry.effectiveProtected ? 'protected' : 'public'}</td>
                <td>{entry.state}</td>
                <td>{entry.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No project protection state has been recorded.</p>
      )}

      <h2>Configure</h2>
      <p>
        The token needs Access Apps and Policies Write plus Organizations, Identity Providers, and
        Groups Read for this account.
      </p>
      {'operation' in status && status.operation && (
        <p>
          To replace an expired or revoked token, keep the saved settings and submit a new token.
          The pending operation will resume.
        </p>
      )}
      <form method="post" action="/admin/zero-trust/configure">
        <p>
          <label>
            Cloudflare account ID
            <br />
            <input
              type="text"
              name="accountId"
              required
              value={'accountId' in status ? String(status.accountId) : context.env.CF_ACCOUNT_ID}
              size={40}
            />
          </label>
        </p>
        <p>
          <label>
            API token
            <br />
            <input type="password" name="apiToken" required size={60} autocomplete="off" />
          </label>
        </p>
        <p>
          <label>
            Identity provider IDs (comma or whitespace separated)
            <br />
            <input
              type="text"
              name="identityProviderIds"
              required
              value={
                'identityProviderIds' in status
                  ? (status.identityProviderIds as ReadonlyArray<string>).join(', ')
                  : ''
              }
              size={80}
            />
          </label>
        </p>
        <p>
          <label>
            Reusable policy IDs (comma or whitespace separated)
            <br />
            <input
              type="text"
              name="policyIds"
              required
              value={
                'policyIds' in status ? (status.policyIds as ReadonlyArray<string>).join(', ') : ''
              }
              size={80}
            />
          </label>
        </p>
        <p>
          <label>
            <input
              type="checkbox"
              name="protectNewProjects"
              value="yes"
              checked={'protectNewProjects' in status ? Boolean(status.protectNewProjects) : true}
            />{' '}
            Protect new projects by default
          </label>
        </p>
        <p>
          <label>
            Existing projects{' '}
            <select name="existingProjects">
              <option
                value="protected"
                selected={
                  !('operation' in status) || status.operation?.existingProjects !== 'public'
                }
              >
                Protect existing projects
              </option>
              <option
                value="public"
                selected={'operation' in status && status.operation?.existingProjects === 'public'}
              >
                Preserve existing projects as public
              </option>
            </select>
          </label>
          <br />
          <small>This selection is used only when Zero Trust is first enabled or re-enabled.</small>
        </p>
        <button type="submit">Save and reconcile</button>
      </form>

      {status.configured && (
        <>
          <h2>Maintenance</h2>
          <form method="post" action="/admin/zero-trust/reconcile" style="display:inline">
            <button type="submit">Reconcile drift</button>
          </form>{' '}
          {(status.enabled || ('operation' in status && status.operation)) && (
            <form
              method="post"
              action="/admin/zero-trust/disable"
              style="display:inline"
              onsubmit="return confirm('Disable Zero Trust and make every project public?')"
            >
              <button type="submit" class="danger">
                {status.enabled ? 'Disable Zero Trust' : 'Cancel setup and clean up'}
              </button>
            </form>
          )}
        </>
      )}
    </Layout>,
  );
});

app.post('/configure', async (context) => {
  const form = await context.req.parseBody();
  let input;
  try {
    input = normalizeZeroTrustConfigureInput({
      accountId: form.accountId,
      apiToken: form.apiToken,
      identityProviderIds: values(form.identityProviderIds),
      policyIds: values(form.policyIds),
      protectNewProjects: form.protectNewProjects === 'yes',
      existingProjects: form.existingProjects,
    });
  } catch (error) {
    adminError(error);
  }
  return executeAuditedMutation(
    context,
    operatorAuditIntent('zero-trust/configure', input),
    async () => {
      try {
        await configurePlatformZeroTrust(context.env, context.get('db'), input);
      } catch (error) {
        adminError(error);
      }
      return { response: context.redirect('/admin/zero-trust'), succeeded: true };
    },
  );
});

app.post('/reconcile', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('zero-trust/reconcile'), async () => {
    try {
      await reconcilePlatformZeroTrust(context.env, context.get('db'));
    } catch (error) {
      adminError(error);
    }
    return { response: context.redirect('/admin/zero-trust'), succeeded: true };
  }),
);

app.post('/disable', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('zero-trust/disable'), async () => {
    try {
      await disablePlatformZeroTrust(context.env, context.get('db'));
    } catch (error) {
      adminError(error);
    }
    return { response: context.redirect('/admin/zero-trust'), succeeded: true };
  }),
);

export default app;
