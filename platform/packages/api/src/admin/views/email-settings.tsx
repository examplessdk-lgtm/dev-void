import type { EmailDomainManagement, EmailRecipientPolicy } from '../../email/settings.ts';
import { Layout } from './layout.tsx';

const META = 'font-size: 0.8rem; color: #666';

export function EmailSettingsPage({
  policy,
  management,
  senderDomain,
  username,
}: {
  policy: EmailRecipientPolicy;
  management: EmailDomainManagement;
  senderDomain: string | undefined;
  username?: string;
}) {
  return (
    <Layout title="Email" username={username}>
      <h1>Email</h1>
      <p style={META}>
        Installation-wide settings. Per-project usage, caps and domains live on each project's email
        page (Projects → project → Email).
      </p>

      <h2>Recipient policy</h2>
      <p>
        Who mail from the shared sender
        {senderDomain ? (
          <>
            {' '}
            (<code>{`<slug>+tag@${senderDomain}`}</code>)
          </>
        ) : null}{' '}
        may reach. Custom-domain sends are not affected.
      </p>
      <form method="post" action="/admin/email/policy" style="margin-bottom: 8px">
        <label style="display: block">
          <input type="radio" name="mode" value="verified" checked={policy.mode === 'verified'} />{' '}
          <strong>verified</strong> — only each project's verified destinations (default)
        </label>
        <label style="display: block">
          <input type="radio" name="mode" value="domains" checked={policy.mode === 'domains'} />{' '}
          <strong>domains</strong> — verified destinations, plus any address on these domains —
          never another project's address on the platform's own mail domain:
        </label>
        <textarea
          name="domains"
          rows={3}
          style="width: 360px; margin-left: 24px"
          placeholder="example.com, corp.example.net"
        >
          {policy.domains.join('\n')}
        </textarea>
        <label style="display: block">
          <input type="radio" name="mode" value="any" checked={policy.mode === 'any'} />{' '}
          <strong>any</strong> — every recipient except another project's address on the platform's
          own mail domain, which still needs that project's verified-destination consent
        </label>
        <button type="submit" style="margin-top: 8px">
          Save policy
        </button>
      </form>
      <p style={META}>
        With <code>domains</code> or <code>any</code>, Cloudflare still refuses a destination it has
        not verified unless the platform mail domain is onboarded for Email Sending (Workers Paid).
        Those refusals arrive as per-recipient <code>UNVERIFIED_DESTINATION</code> results.
      </p>

      <h2>Domain management</h2>
      <p>Who registers custom email domains for projects.</p>
      <form method="post" action="/admin/email/settings">
        <label style="display: block">
          <input
            type="radio"
            name="domains"
            value="self-serve"
            checked={management === 'self-serve'}
          />{' '}
          <strong>self-serve</strong> — project owners grant a Cloudflare credential from{' '}
          <code>void email domain add</code>
        </label>
        <label style="display: block">
          <input type="radio" name="domains" value="admin" checked={management === 'admin'} />{' '}
          <strong>admin</strong> — administrators add domains; <code>void email domain add</code>{' '}
          prints the administrator's command instead
        </label>
        <button type="submit" style="margin-top: 8px">
          Save
        </button>
      </form>
    </Layout>
  );
}
