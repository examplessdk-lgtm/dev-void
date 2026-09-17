---
title: Custom Domain Verification UX Improvements (Single-Stage Display + Status Rollup)
status: superseded by 0073
created: 2026-05-18
---

# RFC: Custom Domain Verification UX Improvements

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Today a user adding a custom domain via `void domain add` sees a partial DNS Setup instructing them to publish a `CNAME` and a `_cf-custom-hostname` `TXT`. When they later run `void domain status`, two additional `_acme-challenge` `TXT` records appear unannounced — they had to add them, but the CLI never told them. This RFC fixes that two-stage reveal by short-polling Cloudflare for the SSL validation records before the API returns from `domainAdd`, so all three records appear in a single screen on the initial command. It also collapses the multi-line `domain status` output into a single rolled-up state to remove the apparent contradiction users hit when CF reports `status: pending` alongside `ssl.status: active`.

This RFC explicitly does **not** propose changing the DCV method, the number of required records, or the architecture of the CNAME target. An earlier draft of this doc proposed per-project CNAME targets plus a switch to HTTP-DCV to reach a single-CNAME UX. That design is empirically known to leave the wildcard-CNAME-hijack vector open under Cloudflare for SaaS, and is documented in the "Rejected Alternatives" section below so the question doesn't get re-litigated.

## Background

The custom-domain flow has evolved over three changes, none of which produced a dedicated design doc:

- **Pre-PR #154.** Created custom hostnames with `ssl.method: "http"` against a shared CNAME target. Users added one `CNAME` and CF handled the rest. **Vulnerable** — a victim with a wildcard CNAME pointing at our shared SaaS target could be silently bound by an attacker. Confirmed end-to-end on production.
- **PR #154** (commit `65edfb71`, 2026-05-15). Switched to `ssl.method: "txt"` and added an activation gate requiring `cfHostname.ssl.method === "txt"`. Closed the hijack vector but introduced two additional user-visible `TXT` records (`_cf-custom-hostname` for ownership pre-validation, plus one or more `_acme-challenge` records for SSL DCV).
- **PR #156** (commit `39b7f621`, 2026-05-17). Dropped `custom_metadata` from the create call — that field requires an Enterprise add-on that an installation may not have enabled.

The triggering user report for this RFC: a user (Alex Lichter) on 2026-05-17 ran `void domain status` for `alexandniki.wedding`, was prompted to publish records the initial `void domain add` had not shown, and asked why both ownership and SSL validation were required. The "why both" question is answered by PR #154 (they're distinct gates against different attacks); the "why didn't the initial command tell me?" is a real bug this RFC fixes.

## Goals

1. **One-screen reveal.** `void domain add` shows the complete required record set in a single output. The user never has to run `domain status` to discover records they should have published.
2. **Single user-facing status.** `void domain status` shows one of a small enumerated set of states (`pending`, `verifying`, `active`, `error`) instead of separate `Status:` and `SSL Status:` lines that can read as contradictory.
3. **No security regression.** TXT-DCV stays. The activation gate (`status === "active" && ssl.status === "active" && ssl.method === "txt"`) stays.

## Non-Goals

- **Reducing the record count below 3.** This is impossible under the current architecture (Cloudflare for SaaS + TXT-DCV). See Rejected Alternatives.
- **Migrating existing domains.** They already work; this RFC doesn't touch them.
- **Per-project CNAME targets.** Empirically don't close the hijack vector under CF for SaaS HTTP-DCV. Future architecture work could revisit this in the context of running our own ACME.
- **Per-project routing isolation, telemetry on cname-target collisions, custom_origin_server.** Out of scope.

## Root Cause: Why The Initial Display Is Incomplete

Cloudflare's `POST /custom_hostnames` response contains `ownership_verification` synchronously (it's a deterministic UUID derived per hostname-creation) but populates `ssl.validation_records` _asynchronously_ — typically within a few seconds, sometimes longer, as CF's cert-provisioning workflow generates the ACME challenge tokens. Our `domainAdd` handler (`platform/packages/api/src/routes/domains.ts:61-86`) takes a single snapshot of the create response and persists whatever CF returned at that moment. Result: `verification_data.ssl_validation_records` is typically empty on first read, the CLI's display code (`packages/void/src/cli/domain.ts:70-77`) sees an empty array and omits the section, and the records first surface on a later `domainStatus` call once CF has populated them.

CF does not block hostname creation on ACME token generation; it returns 200 immediately and the customer is expected to poll. We need to do that polling on their behalf before returning from `domainAdd`.

## Design

### Short-Poll for SSL Validation Records in `domainAdd`

In `platform/packages/api/src/routes/domains.ts`, after `createCustomHostname` returns, if `cfHostname.ssl.validation_records` is empty, **issue follow-up GETs to `/zones/{zone}/custom_hostnames/{id}`** in a bounded short-poll loop until the records appear or a deadline elapses. Concrete shape:

- Deadline: **8 seconds** total wall-clock from create response.
- Interval: **500ms** initial, **750ms** thereafter (~10 attempts within the deadline).
- Stop conditions: `ssl.validation_records` is non-empty, OR `ssl.status === "active"` (unusual but possible if cached cert reuse hits), OR deadline reached.
- On deadline-without-records: log a warning, persist whatever we have, return to the caller. The CLI will surface "SSL validation records will appear in `void domain status` shortly" so the user knows to re-check. This is the genuine asynchronous case where CF really hasn't generated tokens yet — rare, but possible during CA-side incidents.

This adds latency on the happy path (typically ~1-2 seconds) to a command that already takes ~1 second. Acceptable cost for the UX win.

The new helper lives in `platform/packages/api/src/provisioning/cloudflare-api.ts` next to `createCustomHostname`. Signature:

```ts
async function pollCustomHostnameUntilSslRecords(
  zoneId: string,
  apiToken: string,
  customHostnameId: string,
  options?: { deadlineMs?: number; initialIntervalMs?: number },
): Promise<CustomHostnameInfo>;
```

### Single Rolled-Up Status

`void domain status` currently prints `Status: <our DB status>` and `SSL Status: <CF ssl status>` side-by-side, which reads as contradictory whenever those two diverge (e.g. SSL active while overall status pending — a real case captured in the triggering user report on 2026-05-17). It also collapses every non-active CF state into "pending", which means a user waiting on five distinct things (DNS propagation, ownership verification, cert issuance, cert deployment, _or our own project-deployment gate_) sees the same opaque "pending" for all of them.

The rolled-up display computes a single state from the union of CF's status state machine **and** our internal activation gate, and surfaces a one-line diagnostic explaining what is currently blocking activation:

| Computed state        | Trigger                                                                                                        | One-line diagnostic                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `awaiting_dns`        | `cfHostname.status === "pending"` AND `ownership_verification` still returned by CF                            | "Cloudflare has not yet observed your `_cf-custom-hostname` TXT record. Confirm it is published at the host shown above."                                |
| `verifying_dns`       | `cfHostname.status === "pending_validation"`                                                                   | "DNS records found, Cloudflare is validating ownership."                                                                                                 |
| `issuing_cert`        | `cfHostname.status === "pending_issuance"` OR (CF active, `ssl.status !== "active"`)                           | "Cloudflare is issuing the SSL certificate (typically <5 minutes)."                                                                                      |
| `deploying_cert`      | `cfHostname.status === "pending_deployment"`                                                                   | "SSL certificate issued; Cloudflare is propagating it to its edge."                                                                                      |
| `awaiting_deployment` | CF fully `active` AND `ssl.status === "active"` AND our DB still `pending` because `ROUTING.get(slug)` is null | **"Your project has no live deployment yet. Run `void deploy` to bring the domain online."**                                                             |
| `active`              | CF fully `active` AND KV routing written                                                                       | "Live."                                                                                                                                                  |
| `error`               | `verification_errors` non-empty                                                                                | "Verification failed: {first error}". Exact remediation phrasing finalized during implementation against the specific CF error codes we see in practice. |

The `awaiting_deployment` row is the diagnostic gap the triggering user report exposed. Today the API silently keeps the row `pending` if `ROUTING.get(slug)` returns null (a deliberate behavior, per the comment at `platform/packages/api/src/routes/domains.ts:142-156` — flipping the DB before KV is written would leave traffic 404'ing forever), but the user has no way to know they're in that state.

#### API response additions

To compute the rollup the CLI needs CF's raw status and one derived bit indicating whether activation is blocked on our side. The `GET /:id/domains/:domainId` response gains two **additive** fields:

```jsonc
{
  // ...existing fields unchanged...
  "cf_status": "pending_deployment", // raw cfHostname.status pass-through
  "awaiting_deployment": false, // true iff CF gate is satisfied but
  //   ROUTING.get(project.slug) is null
}
```

Both fields are additive; the dashboard's existing consumers continue to work unchanged (lessons.md: "API changes must stay backward compatible with the currently live dashboard"). The dashboard can opt-in to richer status display in a follow-up.

Implementation lives in `platform/packages/api/src/routes/domains.ts` (compute `awaiting_deployment` in the same `gateOk` block that already reads `ROUTING.get(project.slug)`, and pass through `cfHostname.status`). The CLI rollup logic lives in `packages/void/src/cli/domain.ts`. A new `--verbose` flag preserves the existing multi-line breakdown for debugging and for surfacing the still-missing-records list when stuck in `awaiting_dns`.

### Display Refinements in `domainAdd`

While we're in `domain.ts`, fix two adjacent papercuts:

1. **Order the sections deterministically.** Today the sections array (`packages/void/src/cli/domain.ts:58-77`) appends in source order. Make it explicit: CNAME first, ownership TXT second, SSL TXT records third. Each section has a clear purpose stamp.
2. **Add a one-line summary at the bottom** of the DNS Setup block: "Add all three records to your DNS, then run `void domain status <host>` to check progress." This anchors the user — they know they should expect to take three actions and verify.

### API Contract: Additive Only

The `addDomain` route response shape stays identical. The `domainStatus` route gains two additive fields (`cf_status`, `awaiting_deployment`) as detailed above. No fields renamed or removed; the dashboard's existing consumers stay green.

### Testing

- **API integration** (`platform/packages/api/test/integration/api-domains.test.ts`):
  - Mock CF returning empty `ssl.validation_records` on POST and populated records on the second GET — assert `domainAdd` returns the populated records and the short-poll fired.
  - Mock CF returning populated records immediately on POST — assert no follow-up GET fires.
  - Mock CF returning empty records past the deadline — assert `domainAdd` returns gracefully, logs warning, and persists empty `ssl_validation_records`.
- **CLI unit** (`packages/void/test/unit/domain-command.test.ts`):
  - `domain add` happy path shows all three sections (CNAME + ownership + SSL).
  - `domain add` deadline-miss path shows the two known sections + the "records will appear shortly" hint.
  - `domain status` rollup: one assertion per computed state (`awaiting_dns`, `verifying_dns`, `issuing_cert`, `deploying_cert`, `awaiting_deployment`, `active`, `error`).
  - `--verbose` falls back to the current multi-line output.
- **API integration** for the new fields:
  - `awaiting_deployment` is `true` when CF is fully active but `ROUTING.get(slug)` returns null.
  - `awaiting_deployment` is `false` when KV has the slug routing, regardless of CF state.
  - `cf_status` always equals whatever CF returned, with no synthesis on our side.

### Rollout

No ops steps. No DNS changes. No CF dashboard changes. No new entitlements. Code-only.

The original rollout paired the platform API and CLI changes and verified them
against a test domain in a staging installation. Both packages now share the
workspace. This TXT-DCV rollout is superseded by [0073](./0073-custom-domain-http-dcv-migration.md).

## Rejected Alternative: Per-Project CNAME Targets + HTTP-DCV

An earlier draft of this RFC proposed minting a per-project random token, using `<token>.cname.apps.example.com` as the CNAME target, switching to `ssl.method: "http"`, and dropping both `_cf-custom-hostname` and `_acme-challenge` records — yielding a single-CNAME setup.

**The premise was wrong.** Cloudflare for SaaS HTTP-DCV correlates validation requests at the zone level, not at the CNAME-chain-terminal-endpoint level. The earlier investigation recorded in commit `14de2767` reproduced the problem: a wildcard CNAME pointing at the shared SaaS target allowed an attacker to register a victim subdomain without proving ownership. Per-project CNAME targets do not change which CNAME chains terminate within the SaaS zone's namespace; a victim's wildcard pointing at any reachable subdomain of `apps.example.com` still satisfies CF's HTTP-DCV check for _any_ attacker-registered custom hostname in that zone.

CF docs reinforce this. The HTTP-DCV doc says validation succeeds "as long as your customer's hostname points to your SaaS target" (zone-level). The error-codes doc describes the negative case as "Custom hostname does not `CNAME` to this zone" (zone-level). The `custom_origin_server` field exists but is strictly a post-TLS-termination routing knob — it does not constrain DCV.

The only paths that achieve true single-CNAME UX safely are:

- **Run our own ACME.** An independent certificate validation flow could validate the chain endpoint and make per-project CNAMEs a security boundary. This would move custom-hostname TLS termination off CF for SaaS and requires a separate technical design.
- **Move to wildcard custom hostnames at CF** — Enterprise-gated and orthogonal to our use case; not viable.

Per-project CNAME tokens may still have value as a defense-in-depth layer or routing-attribution mechanism in a future change, but they must not be sold as the wildcard-hijack mitigation. The mitigation is TXT-DCV, and as long as we use CF for SaaS for cert issuance, that's the floor.

## Open Questions

- **Short-poll deadline.** 8 seconds is a guess based on the observation that ACME tokens typically appear within 1-2 seconds. If staging shows tail-latency past 8 seconds in normal operation, we extend it. If it shows we never need more than 2 seconds, we tighten it. To be tuned empirically during the staging smoke test, not blocking on merge.
- **Status rollup names.** `pending` / `verifying` / `active` / `error` is the proposed lexicon. Open to alternatives like `awaiting_dns` / `issuing_cert` / `live` / `failed` if the team prefers more action-oriented language. Bikeshed; will finalize in the implementation plan.
- **`--verbose` vs `--debug`** flag naming. Verify against other Void CLI conventions during implementation.

## References

- [HTTP DCV for custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/)
- [TXT DCV for custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/)
- [Pre-validation (ownership)](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/)
- [Custom origin server](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/custom-origin/)
- [DCV backoff schedule](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/backoff-schedule/)
- [Error codes — "Custom hostname does not CNAME to this zone"](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/error-codes/)
- [Cloudflare blog — SSL-for-SaaS v1 vulnerability disclosure](https://blog.cloudflare.com/vulnerability-disclosure-on-ssl-for-saas-v1-managed-cname/)
- Internal: PR #154 (TXT-DCV + activation gate, includes "confirmed end-to-end" exploit reproduction), PR #156 (drop `custom_metadata`)
