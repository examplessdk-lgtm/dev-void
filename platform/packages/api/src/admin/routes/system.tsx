import { Hono } from 'hono';
import type { Handler } from 'hono';
import type { ApiEnv } from '../../env.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { backfillPlatformQueueTokens, systemHealth } from '../../operator/system-operations.ts';
import { getPlatformDisplayName } from '../../platform-identity.ts';
import { renderDashboardFatePage, renderFateListPage } from '../fate/render.ts';
import { readPlatformStatus } from '../platform-status.ts';
import { renderAdminPage } from '../react/server.ts';

export const adminSystem = new Hono<ApiEnv>();

adminSystem.get('/status.json', async (context) => {
  context.header('Cache-Control', 'private, no-store');
  try {
    return context.json(await readPlatformStatus(context));
  } catch {
    return context.json({ error: 'Platform status is temporarily unavailable' }, 503);
  }
});

adminSystem.get('/status', async (context) => {
  const snapshot = await readPlatformStatus(context).catch(() => null);
  return renderAdminPage(context, 'platformStatus', 'Platform status', {
    platformName: getPlatformDisplayName(context.env, context.req.url),
    username: context.get('user').login,
    snapshot,
  });
});

adminSystem.get('/cli-versions', (context) => renderFateListPage(context, 'cliVersions'));

adminSystem.get('/health', async (context) =>
  context.json(await systemHealth(context.get('db'), context.env, context.req.url)),
);
adminSystem.post('/backfill-queue-tokens', async (context) =>
  executeAuditedMutation(context, operatorAuditIntent('system/backfill-queue-tokens'), async () => {
    const result = await backfillPlatformQueueTokens(context.env);
    return {
      response: context.json(result),
      succeeded: result.errored === 0,
    };
  }),
);

export const dashboardHandler: Handler<ApiEnv> = (context) => renderDashboardFatePage(context);
