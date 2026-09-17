import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  listOperatorInvitations,
  parseAccessList,
  revokeOperatorInvitation,
  sendOperatorInvitations,
} from '../../operator/access-service.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { renderOperationError } from '../operation-error.tsx';
import { InvitationsPage } from '../views/invitations.tsx';

const PAGE_SIZE = 50;
const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

app.get('/', async (context) => {
  const page = Math.max(1, parseInt(context.req.query('page') ?? '1', 10) || 1);
  const result = await listOperatorInvitations(context.get('db'), {
    page,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  return context.html(
    <InvitationsPage
      invitations={result.invitations}
      page={page}
      totalPages={result.totalPages}
      username={context.get('user').login}
    />,
  );
});

app.post('/send', async (context) => {
  const body = await context.req.parseBody();
  const emails = parseAccessList(String(body.email ?? ''));
  return executeAuditedMutation(
    context,
    operatorAuditIntent('invitations/send', { emails }),
    async () => {
      await sendOperatorInvitations(context, emails);
      return { response: context.redirect('/admin/invitations'), succeeded: true };
    },
  );
});

app.post('/revoke', async (context) => {
  const body = await context.req.parseBody();
  if (!body.id) {
    throw new OperatorError(400, 'Missing invitation ID');
  }
  const invitationId = String(body.id);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`invitations/${invitationId}/revoke`),
    async () => {
      try {
        await revokeOperatorInvitation(context, invitationId);
      } catch (error) {
        if (error instanceof OperatorError && (error.status === 404 || error.status === 409)) {
          throw new OperatorError(400, 'Invitation not found or not pending');
        }
        throw error;
      }
      return { response: context.redirect('/admin/invitations'), succeeded: true };
    },
  );
});

export default app;
