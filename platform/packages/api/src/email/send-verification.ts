/**
 * Platform-side destination verification email.
 *
 * When project A adds an address that another project already verified via
 * Cloudflare Email Routing, the recipient must consent to project A as well.
 * The destination remains pending until its single-use confirmation link is
 * opened.
 */

import type { ApiEnv } from '../env.ts';

function resolveConfirmationOrigin(env: ApiEnv['Bindings']): string {
  const configured = env.EMAIL_GATEWAY_ORIGIN?.trim();
  if (!configured) {
    throw new Error(
      'EMAIL_GATEWAY_ORIGIN is not configured on the api worker; refusing to send platform verification mail',
    );
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('EMAIL_GATEWAY_ORIGIN must be an HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== configured ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('EMAIL_GATEWAY_ORIGIN must be an HTTPS origin');
  }
  return url.origin;
}

function resolveFromAddress(env: ApiEnv['Bindings']): string {
  const domain = env.EMAIL_SENDER_DOMAIN?.trim();
  if (!domain) {
    throw new Error(
      'EMAIL_SENDER_DOMAIN is not configured on the api worker; refusing to send platform verification mail',
    );
  }
  return `noreply@${domain}`;
}

export async function sendPlatformVerificationEmail(
  env: ApiEnv['Bindings'],
  project: { id: string; slug: string },
  address: string,
  token: string,
): Promise<void> {
  // Resolve deployment configuration outside the delivery catch. A missing
  // binding or identity is a persistent deployment error, not a transient
  // send failure.
  const from = resolveFromAddress(env);
  const confirmationOrigin = resolveConfirmationOrigin(env);
  if (!env.EMAIL) {
    throw new Error('Platform email is not configured.');
  }

  const link = `${confirmationOrigin}/email/destinations/confirm?token=${encodeURIComponent(token)}`;
  const subject = `[${project.slug}] wants permission to email you`;
  const text = [
    `The Void project "${project.slug}" wants permission to send email to`,
    `${address}.`,
    '',
    'Open this link and select Confirm:',
    link,
    '',
    'This link expires in 24 hours and can only be used once.',
    '',
    "If you didn't expect this email, ignore it — no permission is granted",
    'until you select Confirm.',
  ].join('\r\n');

  try {
    await env.EMAIL.send({ from, to: address, subject, text });
  } catch (err) {
    console.error(
      `[email-verify] platform verification email failed for project=${project.id} address=${address}:`,
      err,
    );
  }
}
