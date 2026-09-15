---
title: Custom Domain HTTP-DCV Migration (Ownership-Gated, No _acme-challenge)
status: implemented
created: 2026-06-03
---

# RFC: Custom Domain HTTP-DCV Migration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Custom-domain certificate validation moves from TXT-DCV back to **HTTP-DCV**, while keeping the `_cf-custom-hostname` ownership TXT that closes the wildcard-hijack vector. The activation gate is re-anchored on **hostname ownership** rather than on the cert-DCV method. The result collapses the user-published record set from "1 CNAME + 1 ownership TXT + 1–2 rotating `_acme-challenge` TXT" down to **1 CNAME + 1 (non-rotating) ownership TXT**, and — critically — makes certificate **renewal automatic forever**, eliminating the renewal-time silent-outage class of bugs.

This RFC supersedes [0072](./0072-custom-domain-verification-ux-improvements.md), which deliberately kept TXT-DCV and explicitly rejected HTTP-DCV. The rejection in 0072 was correct _for the analysis available at the time_ but conflated two independent axes (see "The Two-Axis Insight"). The change here is gated behind a **mandatory staging security spike** (Phase 0) that empirically proves the ownership gate — not the cert-DCV method — is the anti-hijack lever. **Nothing ships until that spike passes.**

## Background

The custom-domain flow has now evolved across four changes:

- **Pre-PR #154.** Created custom hostnames with `ssl.method: "http"` against a shared CNAME target, with **no ownership verification and no activation gate keyed on ownership**. Users added one `CNAME` and CF handled the rest. **Vulnerable** — a victim with a wildcard CNAME (`*.victim.com → cname.apps.example.com`) could be silently bound by any attacker, who could register `x.victim.com` as a custom hostname and have CF auto-validate the cert through the victim's wildcard. Confirmed end-to-end on production.
- **PR #154** (commit `65edfb71`, 2026-05-15). Switched to `ssl.method: "txt"` and added an activation gate requiring `cfHostname.ssl.method === "txt"`. Closed the hijack vector — but introduced the user-visible `_acme-challenge` TXT record(s) for SSL DCV, on top of the `_cf-custom-hostname` ownership TXT.
- **PR #156** (commit `39b7f621`, 2026-05-17). Dropped `custom_metadata` from the create call — that field requires an Enterprise add-on that an installation may not have enabled. (We must not reintroduce it here.)
- **RFC 0072** (2026-05-18). Kept TXT-DCV, fixed the two-stage record reveal by short-polling CF for `ssl.validation_records` before `domain add` returned, and rolled up `domain status` into a single state. Explicitly rejected HTTP-DCV as a wildcard-hijack risk.

### Why revisit 0072's decision

Two live problems forced the reconsideration:

1. **Renewal-time silent outages.** The `_acme-challenge` token set **rotates on every certificate renewal** (~90 days). When a renewal generates a new token and no one re-publishes the new `_acme-challenge` value, the cert fails to renew and the domain silently drops back to `pending` / 404. **An observed production incident exposed this failure** — a domain that had been working went dark at renewal with no deploy, no config change, and no actionable signal to the owner. TXT-DCV makes every active custom domain a recurring manual liability.

2. **The confusing "why 2 tokens?" multi-CA case.** Under TXT-DCV, CF can surface **two** `_acme-challenge` records at once (one per backing CA when CF hedges issuance across certificate authorities). Users reasonably ask "why are there two SSL tokens, and which one matters?" — the records are opaque and the count is non-deterministic from the user's point of view. (This is distinct from the ownership-vs-SSL "why both?" question 0072 already addressed; this is specifically the _multiple SSL tokens_ confusion.)

HTTP-DCV eliminates both: there are **no `_acme-challenge` records at all** (the cert is validated at CF's edge once the hostname proxies through it), and **renewals are automatic and invisible** — there is never a user record to re-publish, at first issuance or at any renewal.

## The Two-Axis Insight

0072 treated "use TXT-DCV" as synonymous with "be secure against the wildcard hijack." That conflated two **independent** axes that Cloudflare for SaaS exposes:

| Axis                   | CF field                                | Drives             | User record                          |
| ---------------------- | --------------------------------------- | ------------------ | ------------------------------------ |
| **Hostname ownership** | `ownership_verification`                | top-level `status` | `_cf-custom-hostname` TXT            |
| **Certificate DCV**    | `ssl.method` / `ssl.validation_records` | `ssl.status`       | `_acme-challenge` TXT (TXT-DCV only) |

These are orthogonal. Ownership verification proves the registrant of the custom hostname controls a per-host secret (`_cf-custom-hostname=<value>`), and a wildcard CNAME **cannot forge that per-host TXT value**. The certificate DCV method only governs how the cert order is validated; it is not, by itself, the thing that blocks an attacker from binding a victim's subdomain.

PR #154's `ssl.method === 'txt'` gate clause therefore worked, but for an indirect reason: requiring TXT-DCV forced the existence of a DNS-controlled SSL challenge, which happened to require the attacker to also control DNS. It was a **coarse proxy** for "the registrant controls DNS." The **real anti-hijack lever is the ownership gate** — `ownership_verification` must be satisfied (i.e., no longer outstanding) before we route. CF's own documentation supports this: for a hostname already proxying through Cloudflare, "the hostname will only go active when DNS-based [ownership] validation is complete." Because a wildcard CNAME cannot produce the correct per-host `_cf-custom-hostname` value, `ownership_verification` stays unsatisfied, `status` never reaches `active`, and we never route — **regardless of the cert-DCV method.**

This is why the new gate is **method-agnostic by construction**: it gates on ownership, not on `ssl.method`. That property is also what lets legacy `txt` pending domains activate with no migration and no dual-method shim.

> Why the spike is still mandatory: documentation alone is not sufficient evidence here. Pre-#154 was a _documented-as-safe_ configuration that was nonetheless exploitable in production, because the platform was missing the ownership gate entirely. We do not re-deploy an HTTP-DCV create call on the strength of CF docs again. The spike (Phase 0) reproduces the exploit conditions and proves the gate holds empirically.

## Goals

1. **Eliminate `_acme-challenge` records.** Users publish exactly **1 CNAME (traffic) + 1 `_cf-custom-hostname` TXT (ownership)**. No SSL-validation records at first issuance or ever.
2. **Make renewals automatic and silent.** No user-published record participates in renewal; the renewal-time silent-outage class is structurally eliminated.
3. **No security regression.** The wildcard-hijack vector stays closed — proven empirically by the Phase 0 spike, not by docs.
4. **No migration, no DB schema change.** Legacy `txt` pending domains stay activatable; existing active domains are untouched.

## Non-Goals / Limitations

- **No wildcard custom hostnames.** CF forbids HTTP-DCV on `*.domain` — a wildcard custom hostname requires TXT (or delegated) DCV. Consequently **per-subdomain registration is permanent**: each subdomain a user wants must be registered individually. This is an accepted, structural limitation of choosing HTTP-DCV, not a temporary gap.
- **No per-project CNAME targets.** Still orthogonal to the hijack mitigation (see 0072's rejected-alternatives analysis, which remains accurate); not pursued here.
- **No migration of existing domains.** They already work and are untouched.

## The Two-Axis Gate Change

### Cert DCV method

In `platform/packages/api/src/provisioning/cloudflare-api.ts`, the `createCustomHostname` body changes the SSL method only:

```jsonc
// before (PR #154)
ssl: { method: "txt", type: "dv" }
// after (this RFC)
ssl: { method: "http", type: "dv" }
```

`custom_metadata` stays **out** of the create call (per PR #156 — it requires an unprovisioned Enterprise add-on). We do not reintroduce it.

### Activation gate

In `platform/packages/api/src/routes/domains.ts`, the activation gate is re-anchored on ownership:

```ts
gateOk =
  cfHostname.status === 'active' &&
  cfHostname.ssl.status === 'active' &&
  !cfHostname.ownership_verification; // ownership TXT no longer outstanding
```

The `ssl.method` clause is **dropped entirely** — and deliberately **not** replaced with `ssl.method === 'http'`. Anchoring on the method again would just re-create a coarse proxy and would strand legacy `txt` domains. The `!ownership_verification` clause is the real lever, and it doubles as defense-in-depth: the codebase already treats "`ownership_verification` present ⇒ ownership pending" (the CLI status rollup's `awaiting_dns` branch and the status display both key on its presence), so this gate refuses to route even if CF were ever to flip `status` early. Being method-agnostic by construction is exactly what makes legacy `txt` pending domains activate without a migration or dual-method shim.

`verification_data` continues to carry `{ ownership_verification }`; `ssl_validation_records` is simply empty under HTTP-DCV (expected). No schema or DB migration — `verification_data` is already nullable jsonb. Routing-write paths (`deploy.ts`, `projects.ts`, the backfill cron) already gate only on `status === 'active'`, so they need no change. Dispatch is method-agnostic and is untouched.

### `domain add` no longer short-polls

0072 added a bounded short-poll for `ssl.validation_records` before `domain add` returned. Under HTTP-DCV there are no `ssl.validation_records`, so that poll would burn its full deadline on every `domain add` for nothing. The short-poll and its `pollCustomHostnameUntilSslRecords` helper (plus the associated `CF_HOSTNAME_POLL_*` env knobs / test overrides) are removed; `ownership_verification` is returned synchronously in the create response, so we persist and return immediately — strictly faster than today. `getCustomHostname` stays (the status route still uses it).

## Phase 0 — Security Spike (HARD GATE)

Reproduce the pre-#154 exploit conditions on **staging** (the shared `apps.example.com` CF-for-SaaS zone, `cname.apps.example.com` target), operating at the CF API/DNS layer (not the Access-gated dashboard). Raw CF JSON snapshots and a pass/fail verdict attach to the implementation PR. **This is the ship gate: nothing in Phases 1–4 deploys until Experiment A passes.**

- **Setup.** A throwaway victim domain on a _separate_ CF account with a wildcard `*.victim-spike… CNAME cname.apps.example.com` (test both orange- and grey-cloud).
- **Experiment A — hijack attempt.** From Void's zone, `POST /custom_hostnames { hostname: "x.victim-spike…", ssl: { method: "http", type: "dv" } }` **without** publishing `_cf-custom-hostname`. Poll `GET /custom_hostnames/{id}` across the full DCV backoff window (≥24h).
  - **PASS:** `status` never reaches `active`; `ownership_verification` stays present; the new gate evaluates false at every poll; the edge never serves attacker content.
  - **FAIL → abort the entire change:** `status` reaches `active` without the ownership TXT, or the gate would route.
- **Experiment B — residual probe.** On that same pending hostname, check whether `ssl.status` reaches `active` (CF would issue an _unserved_ cert, producing a CT-log entry). Expected and **accepted** (see "Accepted Residual"); mitigated by the janitor.
- **Experiment C — positive control.** Publish a _specific_ `x2.victim-spike CNAME cname.apps.example.com` **plus** its `_cf-custom-hostname` TXT; confirm `status → active`, `ssl.status → active`, `ownership_verification` disappears, and the gate flips true. Proves legitimate users are not stranded.

### The H1 vs H2 decision

Experiment A resolves the one unknown that decides whether this change is safe at all:

- **H1 (safe — proceed):** pre-#154 was vulnerable because the **platform lacked an ownership gate**, not because CF failed to mint or enforce `ownership_verification`. With the ownership gate in place, the wildcard cannot forge the per-host TXT value, so `status` stays non-`active` and the gate holds. The HTTP-DCV cert method is irrelevant to the hijack.
- **H2 (unsafe — abort):** CF flips `status: active` on HTTP cert-DCV **alone** for an already-proxying hostname, before/independent of ownership. If observed, ownership is not actually gating top-level status, the gate cannot protect us, and **the whole migration is aborted** — we stay on TXT-DCV.

The spike exists precisely to distinguish H1 from H2 with live evidence.

## Accepted Residual + Cleanup Janitor

Under HTTP-DCV, an attacker (or any pending registration) can cause CF to issue an **unserved certificate** for a hostname that never activates — producing **Certificate Transparency log noise** for that hostname. We **accept** this residual (Experiment B confirms it), because it does not enable routing or content serving; it is only CT noise.

To bound it, the hourly cron in `platform/packages/api/src/index.ts` `scheduled()` (the block that already backfills `domain:*`) gains a **7-day pending-domain cleanup janitor**: for any domain with DB `status: 'pending'` and `created_at` older than 7 days, call `deleteCustomHostname` (which revokes the CF cert order) and remove the DB row. This is the safety net because an attacker's wildcard-routed pending hostname keeps resolving to our fallback, so CF's own "Moved → Deleted after 7 days" cleanup may not fire on its own. It reuses the existing `deleteCustomHostname` (`cloudflare-api.ts`) and the `getDomainsByProjectIds` / delete helpers (`db.ts`). Recent pending domains (within 7 days) are left untouched so legitimate slow setups are not reaped.

## Surfaces Touched

- `platform/packages/api/src/provisioning/cloudflare-api.ts` — create-body method (`http`); remove the short-poll helper. (Do **not** reintroduce `custom_metadata`.)
- `platform/packages/api/src/routes/domains.ts` — ownership-anchored activation gate (no `ssl.method` clause); remove the create-time short-poll; verify the delete path triggers CF cert teardown via `deleteCustomHostname`.
- `platform/packages/api/src/index.ts` — 7-day pending-domain cleanup janitor in `scheduled()`.
- `packages/void/src/cli/domain.ts` — `domain add` drops the SSL-validation section (now two sections: CNAME + ownership); `domain status` rollup simplifies the cert/SSL-record blocks since SSL DCV never surfaces user records. Verify CLI and platform behavior together in the unified workspace.
- Tests: `platform/packages/api/test/integration/api-domains.test.ts` (invert the legacy-HTTP-DCV test; add the ownership-still-present-must-NOT-activate regression; assert legacy `txt` active still activates; add a janitor test) and `packages/void/test/unit/domain-command.test.ts` (two-section reveal; drop multi-SSL-record and SSL-pending assertions).

## Rollout

Staging-first per `platform/meta/operations.md` (deploy order api → … → dispatch; only **api** changes here, dispatch is method-agnostic). After the staging deploy, run a real end-to-end `void domain add` on staging and re-run Experiment A against the deployed staging API as a live regression. Promote to prod only after staging passes.

Rollback is clean and code-only (no schema change): revert the gate and create-body. Already-active HTTP-DCV domains keep their certs and keep routing.

## References

- [HTTP DCV for custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/http/)
- [TXT DCV for custom hostnames](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/)
- [Pre-validation (ownership)](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/)
- [DCV backoff schedule](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/backoff-schedule/)
- [Error codes — "Custom hostname does not CNAME to this zone"](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/error-codes/)
- [Cloudflare blog — SSL-for-SaaS v1 vulnerability disclosure](https://blog.cloudflare.com/vulnerability-disclosure-on-ssl-for-saas-v1-managed-cname/)
- Supersedes [0072 — Custom Domain Verification UX Improvements](./0072-custom-domain-verification-ux-improvements.md).
- Historical trigger: a certificate renewal outage in June 2026 exposed the manual TXT renewal dependency.

## Addendum (2026-06-03): Cron-Driven Auto-Activation

### Motivation

The activation gate described above is pull-based: after a user publishes the required DNS records, nothing happens until `void domain status` is explicitly invoked (which calls `GET /:id/domains/:domainId`, which in turn calls `tryActivateDomain()`). This means a correctly-configured domain sits in `pending` indefinitely unless the user polls. There is also a prior sharp edge: if a domain's CF hostname validates _before_ the project has its first deploy (and therefore before the project's slug routing exists in KV), the gate fires false and the domain stays `pending` — requiring the user to issue a second manual `void domain status` after deploying.

The cron-driven reconciliation pass removes both pain points. After DNS is configured, the domain auto-activates within ~2 minutes for recently added domains (within 30 minutes of creation), with no manual polling required. `void domain status` still works for instant activation.

### Implementation

The `scheduled()` handler in `platform/packages/api/src/index.ts` now runs a pending-domain reconciliation pass on every cron tick, reusing **the same `tryActivateDomain()` gate** already used by the `GET /:id/domains/:domainId` status endpoint. There is no second copy of the gate logic — `tryActivateDomain()` is the single source of truth for the security check (`cf.status === 'active' && cf.ssl.status === 'active' && !ownership_verification && !ownership_verification_http`, plus the project must have live slug routing in KV). Per-domain failures (e.g. a transient CF API error) are isolated so one bad domain never aborts the batch.

### Tiered Cadence

The API worker now has **two** cron triggers: `["0 * * * *", "*/2 * * * *"]` (previously only `["0 * * * *"]`).

| Tick                | What runs                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*/2` (fast tier)   | Reconciles **only** pending domains created within `RECENT_PENDING_WINDOW_MS` (30 minutes). No other maintenance runs on this tick.                                                               |
| `:00` (hourly tier) | Runs the full maintenance suite: reconciles **all** pending domains (not just recent ones), then the existing 7-day stale-pending cleanup janitor, then billing rollover and other backfill work. |

**Why two tiers?** The fast every-2-min tick exists solely for user-experience: a domain added minutes ago should activate quickly (within ~2 min for the first 30 min), giving users fast feedback that DNS is correct. After 30 minutes, the domain falls back to the hourly tier. However, running the full reconcile against _all_ pending domains — including stale and abandoned ones — every 2 minutes would massively amplify CF API read load with no user benefit. Restricting the fast tick to the 30-minute window (`RECENT_PENDING_WINDOW_MS`) bounds that cost while keeping fast feedback for the common case.

**Note on `:00` overlap.** `*/2 * * * *` also matches minute 0, so at `:00` both crons fire. The `*/2` invocation does fast-only-and-returns; the `0 * * * *` invocation does full maintenance. No deduplication is needed.

### Cadence Addendum (2026-06-03)

Fast tier retimed from once-per-30-min (`:30`) / 24h window to **every-2-min** / **30-min window**. A freshly added domain now sees its first poll within 2 minutes and is polled every 2 minutes for its first 30 minutes, then falls back to the hourly tier. The `FAST_CRON` constant changed to `*/2 * * * *` and `RECENT_PENDING_WINDOW_MS` changed from 24 hours to 30 minutes. The hourly tier, caps, ordering, suspended-owner skip, and janitor are unchanged.

### Reconcile-Before-Cleanup Ordering

On the `:00` tick, the reconcile pass runs **before** the 7-day stale-pending cleanup janitor. This is deliberate: a domain that has been pending for nearly 7 days but whose CF hostname finally reached `active` in the last hour will be activated by the reconcile pass rather than garbage-collected by the janitor. Without this ordering, a domain near the 7-day cutoff that validates just before the hourly tick could be reaped instead of activated.

### Security and Rollback

Existing active domains are untouched — the reconcile pass only processes domains with DB `status: 'pending'`. The activation gate's security properties are unchanged: the same `tryActivateDomain()` function, the same ownership-anchored checks, applied from a different call site. Rollback is code-only: revert the cron branch and remove the second trigger from `wrangler.jsonc`. No schema change, no data migration.

### Adversarial-Review Hardening (2026-06-03)

A follow-up adversarial review surfaced three issues; the resolution after further review is below.

- **Admin-suspended owners are skipped.** The authenticated `void domain status` route is behind `authMiddleware`, which 403s admin-suspended owners. `reconcilePendingDomains()` now batch-loads the owners of the loaded projects and skips any domain whose owner is admin-suspended (`isAdminSuspended()`), so the cron can never advance a domain the authed path would refuse. Usage-suspended owners (e.g. `requests_exceeded`) retain access and are still reconciled.
- **Activation uses the original KV-first self-healing order.** `tryActivateDomain()` writes the `domain:<host>` KV entry _before_ flipping the DB row to `active`. A crash between the KV write and the DB flip leaves the row `pending`, so the next poll/cron retries and re-writes the same KV entry — the system heals itself without operator intervention. The converse (DB flip first) would strand an `active` row with no route, producing 404s indefinitely. The delete/activate race — a concurrent `void domain delete` interleaving so the cron writes `domain:<host>` KV after the delete already removed the DB row — can leave a rare orphan routing entry (it serves the domain's own project's content). The **7-day stale-cleanup janitor** is a second actor that hits the identical interleave: because `tryActivateDomain()` writes `domain:<host>` KV before flipping the DB row to `active`, there is a sub-second window where an activator has written KV but not yet flipped the row, so the janitor's claim-first `deleteDomainIfPending` still succeeds (the row is still `pending`) and tears the domain down — additionally revoking the CF cert order. This is the same accepted, low-severity, self-healing race class: the affected domain was `pending`/not-yet-serving, so there is no live-traffic outage, and it self-heals via the next `void domain status` returning 404 → the user re-adds. The complete fix is the same deferred lock-free eventual-consistency reconciler (sweep orphan `domain:` KV, repair missing KV for active rows) plus a transition-state on the DB row; a cheap "conditional flip + KV rollback" was considered and **rejected** because it has a two-concurrent-activator footgun — it could delete a valid route when another activator legitimately won. These plus a creation-time custom-domain quota are **deferred** future hardening.
- **Per-run caps (reconcile and stale cleanup).** `getPendingDomains` / `getPendingDomainsNewerThan` and `getPendingDomainsOlderThan` all take a required `limit` and order oldest-first (nearest the 7-day cutoff or most overdue cleaned first). The cron caps each run at `MAX_PENDING_RECONCILE_PER_RUN` (200) and the stale cleanup reuses the same constant, logging a warning when either cap truncates the batch so a large backlog cannot starve later hourly maintenance. A creation-time custom-domain quota is **deferred** as a separate product decision.

### Inline-Review Hardening (2026-06-03): HTTP-DCV Re-Trigger, Janitor Activation, Delete Retry

A second round of PR inline review (Cursor Bugbot + Codex) surfaced findings on the cron work and the create flow; three were fixed, two declined with rationale.

- **HTTP-DCV re-trigger via PATCH (the load-bearing fix).** Void's flow is _add-domain-first_: `void domain add` creates the CF custom hostname with `ssl.method:'http'` **before** the user points the CNAME at `cname.apps.example.com`. Per Cloudflare's Create Custom Hostname API ("if `http` is used and the domain is not already pointing to the Managed CNAME host, the PATCH method must be used once it is"), GET-only polling can leave an add-first domain pending until CF's decaying validation backoff terminates and CF **deletes** the hostname at 7 days. `tryActivateDomain()` now issues a best-effort no-change PATCH (re-sending the `ssl` block, via the new `patchCustomHostname()`), which both re-triggers HTTP DCV and resets CF's backoff. It is gated three ways:
  - `options.retriggerDcv` — **only the hourly reconcile tier opts in.** The every-2-min fast tier and the user `void domain status` route never PATCH. This bounds CF custom-hostname API load: a burst of young pending domains on the fast tier would otherwise fire ~`MAX_PENDING_RECONCILE_PER_RUN` PATCH every 2 min and risk 429ing other tenants' hostname operations, while CF's own sub-minute early retries already cover the first ~20 min. The PATCH's real value (long-tail re-trigger + backoff reset) is fully served at the hourly cadence (~3 PATCH/min worst case).
  - `wasPending && !gateOk` — never PATCH an already-validated or active domain.
  - `cf.ssl.method === 'http'` — **never mutate a legacy `txt`-DCV pending hostname.** A no-change PATCH always sends `ssl.method:'http'`; without this guard, a legacy pending domain (user still publishing rotating `_acme-challenge` records) would be silently switched to HTTP-DCV, discarding its in-progress validation and breaking the no-migration guarantee for legacy `txt` pending domains.
- **Janitor activates verified-but-pending domains.** The 7-day cleanup janitor previously skipped (bare `continue`) any stale row CF reports `active`. It now opportunistically runs `tryActivateDomain()` on that row — loading the project + owner and preserving the admin-suspended-owner skip parity — so a verified domain that aged past the reconcile cap into the janitor comes online rather than sitting unrouted. It still **never deletes a verified host**.
- **Stale-cleanup delete retry.** After the race-safe claim-first `deleteDomainIfPending`, a non-404 `deleteCustomHostname` failure now retries once before logging an explicit `ORPHANED` warning, shrinking the (documented, accepted) orphan-on-transient-CF-error window. The claim-first ordering is unchanged — the reviewers' suggested "delete the CF hostname first" reorder was **declined** because it reopens a strictly worse race: revoking the cert of a domain that a concurrent poll just activated (a live-traffic TLS outage), versus the current benign orphan (CT-log noise + a re-add conflict CF eventually GCs).
- **Status route returns `cname_target`.** `GET /:id/domains/:domainId` now also returns `cname_target` (the `cname.apps.example.com` constant, mirroring the add route) so `void domain status` can surface the traffic CNAME while the cert is still validating.
- **Declined: surface `ownership_verification_http`.** Per CF docs, a non-wildcard `ssl.method:'http'` hostname always returns the `_cf-custom-hostname` TXT `ownership_verification` alongside `ownership_verification_http`, so the user always has an actionable TXT challenge and the "only HTTP ownership challenge → no actionable record → stuck until janitor" scenario is not reachable in this configuration. The gate's dual-field check (treating either field's presence as "ownership not settled") is correct defense-in-depth. No change.

**Forward-progress limitation (carried forward, not newly introduced).** Both the hourly reconcile and the PATCH select the oldest `MAX_PENDING_RECONCILE_PER_RUN` (200) pending rows with no advancing cursor. Under a _sustained_ >200 pending backlog — most plausibly CF-active-but-never-deployed rows the janitor correctly will not delete — the same oldest slice is reselected each hour, so a newer ungated add-first domain in the 30 min–7 day window can be starved of the PATCH (the "pending forever" failure mode, reachable only at that scale). This is the same capped-oldest-first limitation already noted above, now also applying to the PATCH; the deferred **creation-time custom-domain quota** and a **cursor-advancing / lock-free reconciler** remain the planned mitigations. Accepted for now.
