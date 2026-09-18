import { defineHandler } from 'void';
import { fetchApi } from '../lib/api.ts';
import { dashboardRequestOrigin } from '../lib/origin.ts';

export type Props = { methods: Array<{ id: string; label: string }>; error?: string };
export const loader = defineHandler<Props>(async (context) => {
  const response = await fetchApi(context, '/.well-known/void-platform');
  if (!response.ok) {
    return { methods: [], error: 'Login methods are unavailable. Try again shortly.' };
  }
  const discovery = (await response.json()) as { authentication?: { methods?: Props['methods'] } };
  return { methods: discovery.authentication?.methods ?? [] };
});
export const action = defineHandler(async (context) => {
  // Cookie-authenticated mutations must originate in this dashboard.
  if (context.req.header('Origin') !== dashboardRequestOrigin(context)) {
    return context.text('Forbidden', 403);
  }
  const body = await context.req.parseBody();
  if (typeof body.connectionId !== 'string') {
    return context.text('Choose a login method.', 400);
  }
  const response = await fetchApi(context, '/auth/link', {
    method: 'POST',
    body: JSON.stringify({ connectionId: body.connectionId }),
  });
  const result = (await response.json()) as { url?: string; message?: string };
  if (!response.ok || !result.url) {
    return context.text(
      result.message ?? 'Unable to link. Sign in to your existing account again and retry.',
      response.status as 400,
    );
  }
  return context.redirect(result.url, 303);
});
