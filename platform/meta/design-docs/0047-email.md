---
title: Email — Send & Receive via Resend
status: superseded
created: 2026-03-03
superseded_by: 0078-email-cf-native.md
---

> **Superseded on 2026-08-30 by `0078-email-cf-native.md`.** The cost argument
> below was about Resend. Email was later built on Cloudflare Email Routing
> instead, which removes the $90/mo floor and the third-party dependency, so
> the deferral no longer applies. The inbound reasoning held up: routing to the
> correct user worker on Workers for Platforms was the hard part, and it is
> what `0078` spends most of its design on.

# Email — Send & Receive via Resend

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Status: Deferred

After designing the full feature (proxy-based send + inbound webhook routing + CLI domain setup + metering), we concluded that the platform engineering cost doesn't justify the marginal convenience over what users can do themselves with Resend's SDK.

**Key reasoning:**

- **Outbound:** Resend's SDK is already ~3 lines of code. Our wrapper adds convenience (no API key management, unified billing) but not enough to justify proxy changes, framework runtime module, CLI commands, schema migration, and metering infrastructure.
- **Inbound:** This is where real platform value exists — routing Resend webhooks to the correct user worker on Workers for Platforms is genuinely non-trivial. But it doesn't justify the full feature build on its own yet.
- **Cost:** $90/mo Resend Scale plan regardless of usage, plus ongoing maintenance.

**Decision:** Provide documentation instead. Users can set up Resend themselves (SDK + secrets + webhook endpoint). Revisit if email becomes a frequently requested platform feature.

**Unified proxy auth:** The idea of unifying all proxy bindings (`__PROXY` + `__PROXY_TOKEN` replacing `__AI_PROXY` + `__AI_TOKEN`) is independently valuable and should be done when the next platform service is added.

---

## Original Design (preserved for future reference)

### Framework API

**Sending:**

```ts
import { sendEmail } from 'void/email';

await sendEmail({
  from: 'Acme <noreply@myapp.com>',
  to: ['user@example.com'],
  subject: 'Welcome!',
  html: '<h1>Welcome to Acme</h1>',
});
```

**Receiving** (handler at `routes/_email.ts`):

```ts
import { onEmail } from 'void/email';

export default onEmail(async (message) => {
  // message.from, message.to, message.subject, message.html, message.text, message.attachments
});
```

### Architecture

Outbound: user code → `void/email` → `__PROXY` service binding → proxy worker → Resend API (metered via Analytics Engine).

Inbound: Resend webhook → `api.platform.example.net/webhooks/resend` → fetch full body → `POST {slug}.apps.example.com/_void/email` via dispatch → `onEmail` handler.

Domain setup via CLI (`void domain setup-email`, `void domain verify-email`). Schema extends `domains` table with `resend_domain_id` and `email_status` columns.

Metering via Analytics Engine + `UsageCounter` DO enforcement (same pattern as AI). Initial limit: 100 emails/month all tiers.
