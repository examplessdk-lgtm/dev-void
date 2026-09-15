---
title: Decouple GitHub-for-Deploys from Login Provider (First-Class Identity Linking)
status: implemented
created: 2026-06-23
---

# RFC: Decouple GitHub-for-Deploys from the Login Provider

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

> **Status: implemented.** Installations that enable the GitHub App integration
> must register their API origin plus `/github/link-callback` in the app's Callback URL list.

## Summary

A Void user who signed up with **Google** (or any non-GitHub provider) currently cannot use Deploy-on-GitHub. `GET /github/install-url` returns **403** unless the caller already has a linked GitHub OAuth identity (`getCallerGitHubAccountId !== null`, `github.ts:131-134`). The only way to get that identity today is to **log in with GitHub** — which, if the GitHub primary email differs from the account email (or is unverified), creates a **separate Void user** instead of linking (`auth.ts:321-342`). So the practical state is: _Google users can't deploy on GitHub without risking an account fork._

This RFC makes obtaining a GitHub identity a **first-class, authenticated linking action that is independent of how you log in** — the Vercel "connect your Git provider" model. `void github install` auto-runs the link when the caller has no GitHub identity, then the **existing, audited install/connect flow runs unchanged**. The security-sensitive public callback (`/github/callback`) and its confused-deputy protections are **not touched**.

## Background

Two facts, both verified in source:

1. **The install gate is real and load-bearing.** `install-url` embeds `{userId, githubAccountId}` into HMAC-signed `state`. The public `/callback` uses `githubAccountId` to prove — against GitHub — that the person completing the install is the same GitHub account that initiated it (`github.ts:262-279`). This closes a confused-deputy hole: without it, an attacker could phish a victim into installing the App and have the victim's installation (and private repos) bound to the attacker's Void account.

2. **The only path to a GitHub identity is login.** `oauth_accounts(provider='github')` rows are created only in the OAuth login callback. For a user already logged in via Google, the sole way to add a GitHub row is to log in via GitHub, which links **only if** the GitHub primary email is verified **and** matches the existing account email — otherwise it forks a new user (`auth.ts:321-342`). There is **no** "link my GitHub account to my current account" action.

### Comparison: how Vercel handles this

| Axis                     | Vercel                                                                                                                | Implication for Void                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Login identity ↔ account | **1:1** (one GitHub login → one Vercel account)                                                                       | Void's 1:1 is not an outlier; not the thing to fix                                                          |
| Git-for-deploys ↔ login  | **Decoupled** — "connect to other GitHub accounts/orgs from a Vercel account or Team" regardless of how you signed in | **This is the lever.** Void should let any authenticated user connect GitHub, independent of login provider |

Sources: [How to connect a single GitHub account to multiple Vercel accounts](https://community.vercel.com/t/how-to-connect-a-single-github-account-to-multiple-vercel-accounts/37062), [Vercel KB: connecting teams with personal Git accounts](https://vercel.com/kb/guide/connecting-teams-with-personal-git-accounts).

## The root constraint (why we can't just remove the gate)

To bind a GitHub App installation to a Void user, the platform **must** prove that user controls the GitHub account that owns the installation. This is not incidental — it is the entire anti-confused-deputy guarantee. Therefore a GitHub identity **must** be established for the user. The design question is only **when and how** that identity is obtained — **not whether**.

The naive "drop the 403 and bind by `state.userId` alone" reopens the hole:

```
attacker A (no GitHub identity)
  → install-url → state{userId:A}            (no githubAccountId ⇒ no continuity anchor)
  → A sends URL to victim B
  → B installs the App on B's org + authorizes → code_B
  → callback: authorizeInstallViaUserToken(code_B) → caller=B, ids.has(X)=true → authorized
            continuity check (caller == state.githubAccountId) is skipped — nothing to compare
  → installation X (B's repos) bound to A's Void account → A reads B's private repos
```

This is **rejected** (see Alternatives). The continuity check (`github.ts:270`) is exactly what blocks it today.

## Goals / Non-Goals

**Goals**

- Any authenticated Void user (Google, GitHub, future SSO) can use Deploy-on-GitHub.
- Linking GitHub to an existing account **never forks** the account.
- The audited install/connect/callback security model is **preserved unchanged**.
- `void github install` is seamless: it links on demand, then installs.

**Non-Goals**

- Changing the login model or the 1:1 login↔account relationship.
- Allowing one GitHub org to map to multiple Void accounts (mirrors Vercel's unsolved case). Deferred from the linking work; **now designed as a planned follow-up — see [§Follow-up: Org-Shared GitHub App Installations](#follow-up-org-shared-github-app-installations-planned) below.**
- Reworking the public `/callback` ownership proof.
- Closing the pre-existing org-install `read:org` confused-deputy edge (GitHub organization installation ownership) — tracked separately **— addressed by the follow-up below.**

## Design

Add a **first-class, authenticated GitHub-identity link**, decoupled from login, and wire `void github install` to use it.

### 1. Platform — link helper (DB)

`linkGitHubIdentity(db, userId, providerId, login)` in `db.ts`:

- Insert `oauth_accounts(user_id, provider='github', provider_id, ...)` for `userId`.
- **Conflict backstop:** if `provider_id` is already linked to a **different** user, reject (`409`, "this GitHub account is already linked to another Void account"). Mirrors the install backstop (`github.ts:284-287`).
- Idempotent: if already linked to the same user, no-op success.

### 2. Platform — authenticated link flow (three routes, mirrors `void auth login`)

The bind to a user **must not** happen in the public callback against `state.userId` — that reopens an account-linking CSRF (see Security analysis, threat L1). Instead the flow mirrors the existing CLI login: the GitHub result is held as a one-time, PKCE-bound code that is delivered to the **initiator's localhost**, then redeemed by an **authenticated** call that binds to the **token-holder** (not `state.userId`).

- `GET /github/link-url` (**authMiddleware**) → mint a GitHub App **user-OAuth authorize** URL (`https://github.com/login/oauth/authorize?client_id=<GITHUB_APP_CLIENT_ID>&redirect_uri=<API>/github/link-callback&state=…`) with HMAC-signed `state{redirect, purpose:'link', codeChallenge, codeChallengeMethod, exp}`. `redirect` must be a localhost callback (reuse `isLocalhostRedirect`). Fails closed with a clear message when `isAppUserOAuthConfigured(env)` is false. **No `userId` in state** — the bind happens at completion.
- `GET /github/link-callback` (**public, signed-state**) → verify HMAC + `purpose:'link'` + `exp`; exchange `code` → `providerId` via a new exported helper in `github/user-installations.ts` (wraps the existing internal `exchangeInstallCodeForUserToken` → `fetchUserAccountId`; **no installationId** — pure identity); mint a **stateless HMAC-signed `link_code`** embedding `{providerId, codeChallenge, codeChallengeMethod, exp}`; redirect to `state.redirect` (localhost) with `?link_code=…`. **It does not link anything.** Same HMAC-state trust model as `/callback`; no session cookie, no DB row.
- `POST /github/link/complete` (**authMiddleware**) → body `{link_code, code_verifier}`; verify the `link_code` HMAC + `exp`, then PKCE (`isValidCodeVerifier(verifier)` && `createCodeChallenge(verifier) === embedded codeChallenge` && method match), then `linkGitHubIdentity(db, context.get('user').id, providerId)`. Returns `{status:'linked'|'already_linked'}` or **409** on `GitHubIdentityConflictError`.

The PKCE primitives (`createCodeChallenge`, `isValidCodeVerifier`, `CLI_CODE_CHALLENGE_METHOD`) currently live module-private in `routes/auth.ts`; extract them to `src/auth/pkce.ts` (pure, no behavior change) so both `auth.ts` and `github.ts` import them.

The link proves the **current** authenticated token-holder controls a GitHub account, and attaches it to **that** user*id — so no email-matching and **no fork**. Because the result lands on the initiator's own localhost and the bind keys on the token-holder, an attacker can only ever link their \_own* GitHub.

### 3. Platform — install-url (unchanged gate, better signal)

`/install-url` keeps requiring a GitHub identity (security unchanged). Its 403 body becomes a stable, machine-recognizable code (e.g. `{ error: 'github_identity_required' }`) so the CLI can react precisely instead of string-matching.

### 4. CLI — `void github link` + auto-link in `install`

- New `void github link`: mirrors `runLogin`'s localhost + PKCE scaffold (`auth.ts`). Generate a `code_verifier`/`code_challenge`, start the localhost server, call authed `GET /github/link-url?redirect=<localhost>&code_challenge=…`, open the returned authorize URL, receive `?link_code=…` on localhost, then call authed `POST /github/link/complete {link_code, code_verifier}`. Bound to the **current token's user**. Reports "GitHub account linked." / "GitHub already linked." / on 409 "this GitHub account is already linked to another Void account."
- `runInstall` (`github-cmd.ts:117-135`): on `github_identity_required`, **auto-run the link flow, then retry** `install-url` once. If linking is declined/fails, print actionable guidance (`void github link`). The current message ("Run `void auth login` and choose GitHub") is removed — it is misleading and risks the fork.

### 5. Docs

Update `docs/reference/cli.md` (github section): document `void github link`, and that Deploy-on-GitHub works from any login provider after a one-time GitHub link.

### What does NOT change

`/github/callback`, `authorizeInstallViaUserToken`, the continuity check, the cross-user backstop, `getGitHubInstallationsByUser`, and `POST /projects/:id/github` (connect) — all untouched. Install/connect still gate on `github_installations.user_id`, which is set from the signed `state.userId` exactly as today.

## Security analysis

- **Confused-deputy (install):** unchanged. Install still requires `state.githubAccountId`, and `/callback` still enforces continuity (`caller == state.githubAccountId`). Linking only _populates_ `githubAccountId` for the user; it does not weaken the install proof.
- **Threat L1 — account-linking CSRF (the reason for the 3-route design).** If the public `link-callback` bound directly to `state.userId`, attacker A could mint a link-url, phish victim B into authorizing with B's GitHub, and bind B's GitHub identity to A's account (bounded by the conflict backstop to not-yet-linked ids; no repo access, since install still needs the continuity proof — but a real identity-integrity/DoS bug). Closed by deferring the bind: the GitHub result is delivered as a PKCE-bound one-time `link_code` to the **initiator's localhost**, and `POST /github/link/complete` binds it to the **authenticated token-holder**, never `state.userId`. The result lands on the completer's own machine and authorizes with the completer's own GitHub, so an attacker can only ever link their own identity.
- **Link-code integrity:** the `link_code` is an HMAC-signed, short-`exp`, PKCE-bound blob (stateless — no DB row). It is **inert without the `code_verifier`**, which never appears in any URL or redirect (only in the CLI process, sent once over TLS to `/complete`). Non-single-use is acceptable: replay by the same user is an idempotent `already_linked`; replay binding the id to a _different_ user is blocked by the `(provider, provider_id)` unique index (→ `GitHubIdentityConflictError`/409). So the unique index — not a single-use DB row — is the authority that an id maps to exactly one account.
- **Link-flow integrity:** `link-callback` is HMAC-state-authenticated (same model as `/callback`); the conflict backstop (`GitHubIdentityConflictError` → 409) prevents stealing a GitHub identity already owned by another Void user. The code-exchange proves the linker controls the GitHub account.
- **No new GitHub App dependency for the common case:** unlike the rejected decoupling, this design does **not** require "Request user authorization (OAuth) during installation" to be ON. The existing install flow still works via the account-id fallback for personal installs; that setting remains relevant only for org installs (pre-existing behavior).

## Alternatives considered (rejected)

- **A1 — Drop the 403, bind by `state.userId` only.** Reopens the confused-deputy attack above. Rejected.
- **A2 — Authenticated "claim" / polling model** (callback records a pending install; CLI claims it authenticated). Still cannot bind without proving GitHub-account control, so it needs the same identity step — more moving parts, new pending-install state, no security gain over linking. Rejected.
- **A3 — Rely on login-time email-match linking** (`auth.ts:321-342`). Already exists but forks the account when emails differ/unverified, and forces "log in with GitHub." This RFC keeps it as a convenience but it is not the canonical path. Insufficient alone.
- **A4 — Two-route link: public `link-callback` binds directly to `state.userId`.** Simpler (no third endpoint, no GitHub App callback change), but opens the account-linking CSRF in threat L1. Rejected in favor of the deferred-bind 3-route flow.
- **A5 — Reuse the login flow (`/auth/login?link=1` + branch `/auth/callback` + `/auth/cli/link`).** Reuses cookie-nonce/PKCE/code-storage and the already-registered callback (no GitHub App change), and is equally secure. Rejected only for **blast radius**: it edits the audited login path, which this RFC's non-goals keep untouched. The 3-route GitHub-side flow keeps `/auth/*` and `/github/callback` fully isolated.

## Implementation plan (SDD tasks)

Global constraints for all tasks: preserve the `/github/callback` security model untouched; the conflict backstop on linking is mandatory; `github_identity_required` is the stable 403 code contract between server and CLI.

1. **DB link helper** — `linkGitHubIdentity` + conflict backstop in `db.ts`; unit tests (new link, idempotent re-link, conflict→reject). _(api)_
2. **Link routes (3 endpoints, deferred bind)** — extract PKCE primitives to `auth/pkce.ts`; add exported identity-from-code helper in `github/user-installations.ts`; `GET /github/link-url` (authed, localhost redirect + PKCE challenge + `exp` in signed state) + `GET /github/link-callback` (public, signed-state, `purpose:'link'`, mints **stateless HMAC-signed PKCE-bound `link_code`**, no bind) + `POST /github/link/complete` (authed, verifies link*code HMAC+`exp`+PKCE, binds to token-holder via `linkGitHubIdentity`, 409 on conflict); integration tests (happy path links to **current token's user**; forged/altered state reject; non-localhost redirect reject; expired state/link_code reject; PKCE-verifier mismatch reject; conflict→409; \*\*threat-L1 regression: a link_code completed under a \_different* token binds to that token-holder, not to any state.userId\*\*; OAuth-not-configured fails closed). _(api)_
3. **install-url 403 contract** — return `{ error: 'github_identity_required' }`; test the code is stable and still 403s with no identity. _(api)_
4. **CLI `void github link`** — args + cmd + client method + localhost-callback wiring bound to current user; unit tests (arg parse, success/decline/conflict messaging). _(framework)_
5. **CLI `runInstall` auto-link** — detect `github_identity_required` → run link → retry once; remove the misleading message; unit tests. _(framework)_
6. **Docs** — `docs/reference/cli.md` github section: `void github link` + "deploy from any login provider." _(framework)_

Verification: `vp run check` (platform) + `vp run --filter ./packages/void typecheck` (framework); targeted tests per task; full `vp test run` at the end (both repos).

## Operational note

No new env vars. Reuses existing GitHub OAuth client (`GITHUB_APP_CLIENT_ID`/`SECRET`). If those are unset, `void github link` fails closed with a clear "GitHub linking not configured" message — same posture as the existing user-auth-on-install path.

**One owner action (deploy prerequisite):** the 3-route flow uses a new `redirect_uri = <API>/github/link-callback`, so `/github/link-callback` must be added to the GitHub App's **Callback URL** list (it already lists `/github/callback` for install). Add it for staging and prod App configs before the feature goes live. No code/env change.

## Follow-up: Org-Shared GitHub App Installations (planned)

> **Status: planned — not yet implemented.** Everything above (identity linking) is shipped. This section is a separate, approved-but-unbuilt design for the org→multi-user capability that the Non-Goals above deferred. It is gated on an **unconfirmed ops prerequisite** (see below) and should be reviewed before any code is written. It reuses the linking work's deferred-bind scaffold rather than re-introducing it.

### Problem / Summary

Deploy-on-GitHub binds each GitHub App **installation** to exactly one Void user (`github_installations.user_id`). When the App is installed on a GitHub **org**, only the person who initiated the install can see or use it; every other org member is locked out:

```
void github connect (a coworker, org MEMBER)
├─ list installs → db.ts:3999  WHERE user_id = me      → org install EXCLUDED   ◄ root cause
├─ CLI pre-check → "No active installation found"       → exit(1) before any API call
└─ API connect   → github.ts:690  installation.user_id != me → 404
```

Only **three gates** key on installation ownership — listing (`db.ts:3999`, `getGitHubInstallationsByUser`), connect (`github.ts:690`), and the callback backstop (`github.ts:595`). The deploy / push / OIDC path is ownership-**independent** (it keys on `projects.user_id` + `installation_id` + `repository_id` + `account_id` + `status='active'`), so broadening installation _access_ does **not** broaden who can be deployed — a small blast radius. This follow-up lets **multiple Void users who are members of the same GitHub org each connect their own projects** to repos under one shared org installation, without reopening a confused-deputy hole.

### Prerequisite (ops — gate 0, blocks the whole feature)

`GET /user/installations` requires the GitHub App's **user-to-server OAuth**. Before any of this can ship, the App owner must confirm:

- (a) **"Request user authorization (OAuth) during installation" is ON.**
- (b) `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` are set on **prod + staging** `void-api`.
- (c) The `/github/*` callback URLs (join + connect-authorization) are registered on the App.
- (d) **NEW — "Organization → Members: Read" permission** on the App, and the `organization` webhook event subscribed. This org-level permission is the **verified GitHub requirement** to receive `organization` / `membership` / `member` webhook events (used by revocation below). The App does **not** have it today — current scopes are all repo-level (Contents/Metadata/PRs read + Checks write). Adding an org-level permission forces **re-consent by every existing installation** (org owners must approve the new permission) — a real rollout cost, not a silent change.

None of these are documented as set (`operations.md`, `wrangler.jsonc`) — they are only referenced aspirationally in the linking work above. The whole feature **must fail closed** via `isAppUserOAuthConfigured` (`github/user-installations.ts:27-35`) when any of it is absent. **This prerequisite is UNCONFIRMED in prod and must be verified with the App owner before building.**

### Design

**Model:** keep `github_installations.user_id` as the _installer/owner_, and add a **many-to-many membership** table so access is no longer 1:1. Access is always proven against **GitHub's own** authorization (`GET /user/installations[/:id/repositories]`) — never a Void-side assertion of "you're in the org." No GitHub tokens are persisted; each proof is a fresh authorize round-trip, its result cached as a TTL-bounded row.

```
NEW TABLE  github_installation_members
  installation_id   FK → github_installations
  user_id           FK → users            (a Void user with proven access)
  github_account_id text                  (their numeric GitHub id, for audit)
  verified_at       timestamp
  expires_at        timestamp             (TTL cache of the GitHub proof)
  UNIQUE (installation_id, user_id)
```

**Two capabilities, both riding the linking work's deferred-bind scaffold** (`/github/link-url` → `/github/link-callback` → `POST /github/link/complete`, PKCE + HMAC state, no token persisted):

```
1. JOIN  (discovery + eligibility)                  reuses authorizeInstallViaUserToken (shipped)
   void github install / join
     → GitHub user-OAuth authorize round-trip (PKCE + HMAC state, no token stored)
     → callback: GET /user/installations includes this install?  ── yes ──► upsert member row (TTL)
     → now `void github installations` lists it and connect is eligible

2. CONNECT-AUTHORIZATION  (closes the confused-deputy gap)
   owner connecting          → synchronous, unchanged (already proved control at install)
   NON-owner connecting a repo → one authorize round-trip whose callback verifies, with the
                                 CONNECTING user's own token, that
                                 GET /user/installations/:id/repositories includes the target repo,
                                 then mints a short-lived signed connect-grant the CLI redeems.
                                 (Live per-repo check — a member cannot connect a repo they
                                  personally cannot access.)
```

Both reuse the linking work's bind-to-the-authenticated-token-holder discipline (never `state.userId` — see Threat L1 above); the JOIN result is cached as a membership row rather than an `oauth_accounts` link, and no token is retained.

**Gate changes (the only three):**

```
listing  db.ts:3999    WHERE user_id = me            →  WHERE user_id = me OR EXISTS(member row)
connect  github.ts:690 installation.user_id == me    →  owner OR member  (+ per-repo authz below)
backstop github.ts:595 403 "already linked to other" →  INSERT member row (owner stays installer)
```

`upsertGitHubInstallation` adopt-guard (`db.ts:3925`) and `linkGitHubInstallationToUser` (`db.ts:4089`) keep setting the single _installer_ `user_id`; membership is additive on top. **Untouched (confirmed safe):** update / status / build-list / build-logs (already project-owner keyed), and the entire deploy/push/OIDC path (ownership-independent). A membership grant lets a user _connect their own project_; it never changes who an existing connection deploys as.

### Security analysis

**Confused-deputy close (per-repo verified).** The gap today: connect validates the target repo with the **installation** token, never the connecting user's own token (`github.ts:711-729`) — fine for a single owner who already proved control at install, but for a shared install a member could connect a private repo they individually cannot access.

```
Threat: a shared-install member connects a repo they can't personally access → reads its
        build logs / deploy artifacts they shouldn't see.
Close:  non-owner connect verifies the SPECIFIC repo against the CONNECTING user's own GitHub
        token (GET /user/installations/:id/repositories), live at connect. Owner path unchanged.
Reuse:  same deferred-bind + PKCE + HMAC-state model the linking work uses; bind to the
        authenticated token-holder, never state.userId (Threat L1 above).
```

**Key insight — the deploy path is ownership-INDEPENDENT, so revocation must ACTIVELY sever connections.** Because deploy / push / OIDC key on `projects.user_id` + `installation_id` + `repository_id` + `account_id` + `status='active'` and never on installation ownership or membership, simply letting a membership row lapse does **not** stop deploys. A member who is removed from the GitHub org but whose project is already connected would **keep auto-deploying** on every push to the org repo — a fired-employee-still-deploys hole. Revocation therefore has to cut the connections, not just the membership. This makes event-driven revocation a first-class, non-optional part of the design.

### Revocation (event-driven)

When a user is **removed from the GitHub org**, we proactively remove them on our side, driven by a webhook the App does not handle today.

```
NEW webhook handler:  organization / member_removed   (not subscribed/handled today)
  payload → { organization.id  (org account id),  membership.user.id  (removed GitHub user id) }

  1. installs   = github_installations WHERE account_id = org.id AND account_type='Organization'
  2. voidUsers  = oauth_accounts WHERE provider='github' AND provider_id = removed_user.id  → user_id(s)
  3. DELETE github_installation_members WHERE installation_id ∈ installs AND user_id ∈ voidUsers
  4. SEVER their connections to that org  (the security-meaningful step — stops future deploys):
        conns = github_connections JOIN projects
                WHERE installation_id ∈ installs AND projects.user_id ∈ voidUsers
        → delete / disable those connections
  5. if the removed user was the installer OWNER (github_installations.user_id ∈ voidUsers):
        clear the owner pointer (feature then relies on remaining members)  ← sub-decision below

  • idempotent (webhook redelivery safe);  no-op when the removed GitHub user has no linked Void user
  • scoped strictly by account_id so it only touches THAT org's installs
```

**Boundary (documented):** revocation stops future GitHub-triggered deploys and hides the install; it does **not** tear down the user's already-deployed sites — they still own their Void project. `organization / member_added` needs no eager action (the user JOINs via authorize when they want in).

**TTL as a backstop (defense in depth):** keep `expires_at` on the membership row so access still lapses if the webhook is ever missed (delivery failure, permission not yet granted, App installed after the removal). Webhook = fast path; TTL = safety net — generalized in **Eventual consistency** below.

### Eventual consistency (missed webhooks)

Webhook delivery is best-effort: GitHub can be down, we can be down, or a delivery can return 5xx. The revocation path above is **push-only** today (plus the membership `expires_at` backstop), so a design for missed events is required, not optional. Principle: **webhooks are the fast path, never the correctness authority** — eventual consistency needs (a) a way to re-pull events we missed and (b) leases so a missed event degrades a grant to _stale ≤ window_ instead of _stale forever_.

**First, classify a miss by blast radius — does the stale row fail safe or fail open?**

```
MISSED EVENT                    stale DB says…        real effect                        class
────────────────────────────   ──────────────────    ─────────────────────────────      ─────
installation.deleted/suspend    "still active"        install-token mint fails at        FAIL-SAFE
installation_repositories.rm    "repo still covered"  GitHub → deploy just errors        (GitHub is
installation.created            "no install"          user can't use it (annoying)        the real gate)

organization/member_removed     "still a member" +    deploy path is ownership-          FAIL-OPEN ⚠
                                connection alive       independent → the repo KEEPS
                                                       auto-deploying on every push
workflow_run.completed          check "in_progress"   check-run stuck (cosmetic)         bounded orphan
```

Only `member_removed` **fails open** — every other miss is self-correcting because GitHub rejects the stale grant at the next token operation. `member_removed` is the one where nothing at push time re-checks the human, so a missed delivery = unauthorized deploys until some other lease expires the grant.

**Three backstops, by leverage (none built today — this is the proposed layer):**

1. **Delivery replay — recovers _our_ downtime.** GitHub tracks the success/failure of every delivery it sends, and a **failed** delivery (our endpoint returned non-2xx or was unreachable) is exactly a webhook we didn't ack — so GitHub's own record is the source of truth, no inbound-GUID logging needed. A scheduled catch-up job lists `GET /app/hook/deliveries?status=failure` (app-JWT auth) and re-sends each via `POST /app/hook/deliveries/{id}/attempts`, deduped by a `guid`-keyed ledger so each failed event is redelivered at most once (GitHub's failed-delivery history is append-only, and a redelivery shares the original `guid`, so this also bounds a permanently-failing event to one retry). Safe to replay blindly _because_ handlers are already idempotent and the revocation tombstone is monotonic. Generic — recovers every event type. Bounded per run; runs inside GitHub's delivery-retention window.

2. **Lease the connection — the only structural close for a missed `member_removed`.** We deliberately store **no** user token and defer `read:org`, so we **cannot pull** "is B still in org X" from the app side. So don't: make the grant expire. Add `verified_at` / `lease_expires_at` to `github_connections` (it has neither today) and have the deploy path require a re-proof (the same connect-authorize round-trip) once the lease is stale. A missed `member_removed` then stops within one lease window instead of deploying forever — extending the membership-`expires_at` idea to the row that actually authorizes deploys. Cost: periodic re-auth friction. _(Alternative: take `read:org` + a membership reconciler that severs connections for users no longer in the org — removes the friction but forces re-consent on every existing install.)_

3. **Periodic app-auth reconciler — cleans the fail-safe-but-stale rows.** A scheduled sweep (reuse the `BuildManager` DO-alarm pattern), APP creds only (no user token, no `read:org`): `GET /app/installations/{id}` → mark gone/suspended installs; diff `GET /installation/{id}/repositories` → prune connections to dropped repos. Lower urgency (these already fail closed at use), turns "stale until hit" into "reconciled within a sweep."

**Platform-down vs GitHub-down:**

```
OUR platform down  → GitHub auto-retries + delivery replay (1)  → full recovery
GitHub down        → GitHub queues/retries on its side (nothing lost that it hasn't sent);
                     the deliveries API is truth on recovery. A LONG outage is bounded by the
                     connection lease (2) + the sweep (3), not by the webhook.
```

**What already makes replay safe (keep it):** idempotent handlers (replay re-applies without harm), monotonic revocation tombstones (a late/out-of-order artifact with `iat ≤ revoked_at` fails closed), and the 24h membership TTL (listing/connect eligibility self-heals). These are the foundation the three backstops build on.

**Build first:** the delivery-replay job (1) — cheapest, recovers all event types, reuses the idempotent handlers. **Security-first:** lease the connection (2) — the only close for the fail-open case that needs neither a stored token nor `read:org`.

### Alternatives (deferred / rejected)

- **Org-membership-level boundary (coarser, less friction):** installation membership alone authorizes connecting _any_ repo the install covers; skip the per-repo connect check. Simpler and no connect-time round-trip, but a member could connect a private repo they individually cannot access (org-internal trust assumption). Ship-first candidate if the per-repo friction is unwanted — the per-repo check can be layered on later without schema change.
- **Persist a refreshable user token:** store the GitHub user token encrypted (reuse the `project-secrets` AES-GCM at-rest scheme) to check access live/seamlessly. Best DX, but adds GitHub-token-at-rest + refresh handling the code deliberately avoids today. Rejected as default.
- **Manual DB repoint (`UPDATE github_installations.user_id`):** the current-only unblock; single-owner, not sharing. This is the interim workaround the follow-up supersedes.

### Open decisions (defaults marked)

1. **Trust boundary** — **per-repo verified** [default] (secure; matches the linking work's stance) vs. org-membership-level (less friction).
2. **Access persistence** — **cached membership, no stored token** [default] vs. persist a refreshable token for seamless live checks.
3. **Revocation on org-removal** — sever connections + delete membership (proactive via `organization/member_removed`, TTL backstop). Sub-decision: **hard-delete** vs. **disable** the severed `github_connections` (disable is reversible on re-join; delete is clean).
4. **Removed installer/owner** — **clear the owner pointer** and fall back to members [default] vs. transfer the owner pointer to the oldest remaining member.

### Implementation plan (SDD tasks)

Gated on the ops prerequisite (gate 0) being confirmed first — do not start until the App owner confirms user-OAuth + the org-Members permission + re-consent path. For a later pass:

1. **Schema — `github_installation_members`** — add the table beside `githubInstallations` / `githubConnections` in `schema.ts` (~`:346-436`) with columns and `UNIQUE (installation_id, user_id)`; migration; membership upsert/delete/query helpers in `db.ts` (reverse-lookup pattern at `db.ts:259-263`). _(api)_
2. **Listing gate** — `getGitHubInstallationsByUser` (`db.ts:3999`) → `WHERE user_id = me OR EXISTS(member row)`; tests (owner sees own; member sees joined; non-member excluded). _(api)_
3. **JOIN flow** — reuse `authorizeInstallViaUserToken` + the deferred-bind scaffold; callback checks `GET /user/installations` includes the install → upsert TTL member row; fail closed on `isAppUserOAuthConfigured`; integration tests (join succeeds for org member, rejected for non-member, expired/forged state reject). _(api)_
4. **Connect-authorization** — owner path synchronous unchanged; non-owner path does the one-time authorize round-trip verifying the specific repo via `GET /user/installations/:id/repositories` with the connecting user's own token, mints a short-lived signed connect-grant; connect gate (`github.ts:690`) → owner OR member + per-repo authz at the repo-resolution insertion point (`github.ts:710-729`); tests (member connects an accessible repo; member blocked on an inaccessible repo; owner unaffected). _(api)_
5. **Callback backstop** — `github.ts:595` "already linked to other" path → INSERT member row (owner stays installer); tests. _(api)_
6. **Revocation webhook** — add an `organization` case beside the existing `installation` / `installation_repositories` cases (event switch at `webhooks.ts:160`); handle `member_removed` per the steps above; idempotent; tests (sever connections, clear owner pointer when installer removed, no-op for unlinked GitHub user, redelivery safe). _(api)_
7. **CLI** — `void github install` / `join` triggers the JOIN authorize round-trip; connect surfaces the non-owner authorization step; tests + `docs/reference/cli.md`. _(framework)_
8. **Eventual-consistency backstops (later pass)** — a scheduled **delivery-replay** job: list `GET /app/hook/deliveries?status=failure` (app-JWT) → redeliver via `POST …/attempts`, deduped by a `guid`-keyed redelivery ledger (each failed event retried at most once); idempotent handlers make replay safe. Runs as a best-effort step in the hourly `scheduled()` branch, gated on the App secrets. Optionally lease `github_connections` (`verified_at` / `lease_expires_at` + deploy-time re-proof) and a periodic app-auth install/repo reconciler. See **Eventual consistency (missed webhooks)** above. _(api)_

Verification: `vp run check` (platform) + `vp run --filter ./packages/void typecheck` (framework); targeted tests per task; full `vp test run` at the end.
