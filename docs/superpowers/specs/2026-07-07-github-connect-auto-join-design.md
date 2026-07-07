# `void github connect` auto-join — Design

Date: 2026-07-07
Status: Approved

## Problem

An org teammate runs `void github connect` after someone else in their org already
installed the Void GitHub App. `GET /github/installations` only returns
installations where the caller is the owner or already has an active membership
row, so the teammate sees zero installations and the CLI exits with
`No active GitHub App installation. Run `void github install` first.` — telling
them to install an app that is already installed.

## Decision

CLI-only change (`packages/void/src/cli/github-cmd.ts`). When `connect` finds
zero active installations on an interactive terminal, auto-run the **existing**
join browser OAuth flow instead of erroring, then re-list and continue.

Rejected alternative: a silent server-side org-membership probe via
`GET /orgs/:org/memberships/:username` with the installation token. Rejected
because the GitHub App lacks the org `Members: Read` permission (adding it
forces a re-consent wave across every installed org, see
void-platform `meta/operations.md`), the platform stores only numeric GitHub
account ids (no username), and void-platform design doc 0074 deliberately
requires access to be proven by the user's own GitHub authorization, never a
Void-side assertion.

Rejected alternative: repo-first precheck endpoint ("does an active org install
cover repo X?") before the popup. Rejected because it leaks private-repo
existence and org Void usage to any authenticated user, weakening the
opaque-404 stance of design doc 0074.

## Behavior

```
void github connect
  │
  ▼
list installations (active)
  │
  ├─ non-empty ────────────────────────────► continue as today
  │
  └─ EMPTY
      ├─ not a TTY (CI) ──► error (no popup); message also mentions
      │                     `void github join`
      └─ TTY:
          log: no installation linked yet — checking whether your
               organization already installed the app…
          ▼
          existing join OAuth popup (same endpoints; no server change)
          ├─ joined ≥ 1 ──► re-list installations ──► continue connect
          ├─ joined 0 ────► error: "No GitHub App installation found for
          │                 your account or your organizations. Run
          │                 `void github install` first."
          └─ 503 github_oauth_not_configured ──► same error as joined-0
                                                 (fall through, no crash)
```

The "someone else already installed AND the installation covers the repo"
condition is enforced by existing machinery: join only binds installations
GitHub confirms the user can access; repo coverage is enforced at connect
(owner: cached coverage check; member: per-repo connect-authorize popup).

## Changes

1. **Extract `performGithubJoin(client): Promise<number>`** from
   `runGithubJoin` (`github-cmd.ts:322-373`): the PKCE + browser round-trip +
   `completeGithubJoin`, returning the joined count and throwing
   `PlatformApiError` (including the 503) instead of calling `process.exit`.
   `runGithubJoin` keeps its exact current user-facing behavior on top of it.
2. **Empty-list fallback in `runConnect` step 2** (`:503-510`): on empty list +
   TTY, run `performGithubJoin`; on count > 0 re-list; if the list is still
   empty (or join threw the 503), print the improved error and exit 1.
3. **`--installation <id>` recovery** (`:514-519`): when the id is not in the
   list (TTY only), attempt the join once, re-list, re-find; if still missing,
   keep the current error.
4. **Member repo prompt fix in step 3** (`:548-553`): the server redacts
   `repositories` to `[]` for non-owner (member) rows, so
   `repository_selection === 'selected'` with an empty list currently
   dead-ends with "The installation has no accessible repositories". On a TTY,
   prompt for `owner/repo` as free-text input instead (validated as
   `owner/name` shape); the server still verifies real access afterward.
   Non-TTY: keep an error, reworded to suggest `--repo <owner/repo>`.
5. **Docs**: update `docs/reference/cli.md` for `github connect`; grep
   `packages/void/skills/void`, `packages/void/AGENT_PROMPT.md`,
   `packages/void/getting-started-prompt.txt` for stale "run install/join
   first" guidance.

## Not changing

No server/API changes (void-platform untouched). No GitHub App permission
changes. No change to the per-repo connect-authorize popup for members. Trust
model of design doc 0074 intact.

## Testing

Unit tests beside existing `github-cmd` tests with a mocked `PlatformClient`:

- empty list → join returns 1 → re-list returns install → connect proceeds
- empty list → join returns 0 → improved error, exit 1
- empty list → join throws 503 `github_oauth_not_configured` → improved error
- non-TTY + empty list → no join attempt, error mentions `void github join`
- `--installation <id>` not in list → join recovers it → connect proceeds
- member repo prompt: `selected` + empty repositories + TTY → free-text prompt
  used; invalid `owner/repo` input re-prompted/rejected; non-TTY → error
  suggesting `--repo`
