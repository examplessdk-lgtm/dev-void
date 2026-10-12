import { desc } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  registerOAuthClient,
  publicOAuthClient,
  disableOAuthClient,
  OAuthError,
} from '../../auth/oauth.ts';
import { isDevBypass, type ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { oauthClients } from '../../schema.ts';
import { renderAdminPage } from '../react/server.ts';

const app = new Hono<ApiEnv>();
app.onError((error, context) =>
  renderAdminPage(
    context,
    'connectedApps',
    'Connected apps',
    {
      clients: [],
      error: error instanceof OAuthError ? error.message : 'The operation failed.',
      platformName: getPlatformDisplayName(context.env, context.req.url),
      username: context.get('user').login,
    },
    { status: error instanceof OAuthError ? error.status : 400 },
  ),
);
app.get('/', async (context) =>
  renderAdminPage(context, 'connectedApps', 'Connected apps', {
    clients: (
      await context.get('db').select().from(oauthClients).orderBy(desc(oauthClients.created_at))
    ).map(publicOAuthClient),
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
  }),
);
app.post('/', async (context) => {
  const body = await context.req.parseBody();
  const input = {
    name: body.name,
    operator: body.operator,
    redirectUris: String(body.redirectUris ?? '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    scopes: ['profile', ...(body.publish === 'true' ? ['deploy:approve'] : [])],
  };
  return executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/register', input),
    async () => {
      const { client, clientSecret } = await registerOAuthClient(
        context.get('db'),
        input,
        isDevBypass(context.env),
      );
      return {
        succeeded: true,
        response: await renderAdminPage(context, 'connectedApps', 'Connected apps', {
          clients: [client],
          credentials: { clientId: client.id, clientSecret },
          platformName: getPlatformDisplayName(context.env, context.req.url),
          username: context.get('user').login,
        }),
      };
    },
  );
});
app.post('/:id/disable', async (context) =>
  executeAuditedMutation(
    context,
    operatorAuditIntent('oauth/clients/disable', { id: context.req.param('id') }),
    async () => {
      await disableOAuthClient(context.get('db'), context.req.param('id'));
      return { succeeded: true, response: context.redirect('/admin/connected-apps') };
    },
  ),
);
export default app;
