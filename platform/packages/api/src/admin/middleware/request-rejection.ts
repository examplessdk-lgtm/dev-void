import type { Context } from 'hono';
import type { ApiEnv } from '../../env.ts';

export function adminAccessRejected(
  context: Context<ApiEnv>,
  reason: 'required' | 'suspended',
): Response {
  if (reason === 'suspended') {
    return context.html(
      '<h1>Administrator access suspended</h1><p>Contact another platform administrator to restore access.</p><p><a href="/admin/logout">Sign in with another account</a></p>',
      403,
    );
  }
  return context.html(
    '<h1>Administrator access required</h1><p>Sign in with an administrator account for this platform.</p><p><a href="/admin/logout">Sign in with another account</a></p>',
    403,
  );
}

export function adminRequestRejected(
  context: Context<ApiEnv>,
  error: string,
  format: 'json' | 'text',
): Response {
  const message = 'Return to the admin page, refresh it, and try again.';
  if (context.req.header('Accept')?.includes('text/html')) {
    return context.html(
      '<h1>Request could not be verified</h1><p>Return to the admin page, refresh it, and try again.</p><p><a href="/admin/">Return to admin</a></p>',
      403,
    );
  }
  return format === 'json'
    ? context.json({ error, message }, 403)
    : context.text(`${error} ${message}`, 403);
}
