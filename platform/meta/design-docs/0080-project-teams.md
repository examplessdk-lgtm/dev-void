---
title: Project teams and ownership transfer
status: implemented
created: 2026-09-17
---

# Project teams and ownership transfer

## Summary

Add project-scoped membership to the Void Platform. A project keeps one owner,
and can additionally have readers, collaborators, and project administrators.
The owner remains the billing and quota subject regardless of which member
performs an action.

This is a Void Platform control-plane feature. It does not add an organization
object, change application manifests, or affect projects deployed directly to
Cloudflare.

## Goals

- Let an owner or project administrator invite people to a project.
- Let authorized members view or operate the project according to their role.
- Let the owner and project administrators change or remove non-owner members.
- Let an installation administrator transfer a project to another existing
  Platform user.
- Apply the owner's plan, billing period, suspension, and quota state to the
  project even when another member deploys or configures it.
- Make membership removal and role downgrade revoke new work immediately and
  prevent an already-issued deploy credential from publishing afterward.
- Keep existing single-owner projects working without a data migration that
  manufactures membership rows.

## Non-goals

- Reusable teams, organizations, organization-wide roles, or shared billing
  accounts.
- Membership on direct Cloudflare deployments.
- Multiple owners or project ownership by a group.
- Project members who do not have their own Void Platform account.
- Sharing the installation administrator role through a project role.
- Reading stored secret values. The existing API exposes secret names and
  write/delete operations, not plaintext reads; teams do not change that.

## Terminology

- **Installation administrator**: a user whose account has `users.role =
'admin'`. They use the browser admin UI or `/operator/v1` API.
- **Project administrator**: a project member with role `admin`. This role has
  no installation-wide authority.
- **Owner**: the user referenced by `projects.user_id`. The column retains its
  current name for an additive, backward-compatible rollout, but means
  `owner_user_id` throughout this design.
- **Actor**: the authenticated user who requested an action.
- **Billing owner**: the project owner whose plan and counters authorize and
  account for the action.

## Product decisions

### Project roles

The owner is implicit and is not duplicated in `project_members`. Permissions
are capability lists rather than string comparisons so a later role can be
added without relying on role ordering.

| Capability                                                        | Reader | Collaborator | Project admin | Owner |
| ----------------------------------------------------------------- | :----: | :----------: | :-----------: | :---: |
| View project, usage, resources, domains, builds, deploys and logs |   ✓    |      ✓       |       ✓       |   ✓   |
| View member roster                                                |   ✓    |      ✓       |       ✓       |   ✓   |
| Deploy, cancel, roll back, revalidate and run migrations          |        |      ✓       |       ✓       |   ✓   |
| Perform deploy prerequisites and manage secrets/database config   |        |      ✓       |       ✓       |   ✓   |
| Manage domains, email destinations and GitHub connection          |        |              |       ✓       |   ✓   |
| Invite, change roles, revoke invitations and remove members       |        |              |       ✓       |   ✓   |
| Delete the project                                                |        |              |               |   ✓   |
| Transfer ownership                                                |        |              |               |       |

Only an installation administrator can transfer ownership. A project
administrator may invite or promote another project administrator, but cannot
change, remove, or impersonate the owner. A non-owner member may leave the
project. The owner cannot leave until an installation administrator transfers
the project.

Deploy permission intentionally includes production code execution, secret
updates, migrations, and automatic resource provisioning. Treating those as
lower-trust operations would be misleading: code that can be deployed can
already act with the application's runtime bindings. Domains, email recipient
policy, GitHub automation, membership, and project deletion remain separate
administrative capabilities.

These role boundaries are confirmed product policy. Project administrators can
manage any non-owner member, including another project administrator.

### Owner-based limits

For every project operation, authorization has two independent inputs:

1. the actor's project capability determines whether the action is allowed;
2. the current owner's account determines the applicable plan and quota.

The actor's personal plan never raises or lowers the project's limits. This
applies to request and AI usage, deploys per day, build concurrency and timeout,
build instance size, CPU and subrequest limits, deployment retention, and future
account-level storage enforcement. Managed Sandbox is currently hard-disabled;
its runtime and concurrency attribution must be specified before that capability
is reintroduced.

A manually suspended actor cannot authenticate, even if they are a member. An
actor automatically suspended for usage on projects they own may still work on
someone else's project. A manually suspended owner suspends their owned
projects. An owner's usage suspension continues to apply to their projects and
cannot be bypassed by a collaborator deploying them.

### Ownership-transfer accounting

Ownership changes are effective at one database timestamp and are not
retroactive:

- usage before the timestamp remains charged to the former owner;
- usage at or after the timestamp is charged to the new owner;
- the new owner's plan, runtime limits, and suspension state apply immediately
  after the transfer commits.

This prevents account dashboards and enforcement counters from silently
rewriting a completed billing period. Only an installation administrator can
transfer ownership, and every transfer is previewed and audited, which prevents
this rule from becoming a self-service quota-avoidance mechanism.

The former owner becomes a project administrator after transfer. If the new
owner was already a member, that membership row is removed because ownership
is implicit. This preserves access for both people and avoids choosing a role
for the former owner in every operator invocation. The new owner may remove the
former owner afterward.

The target must be an existing Platform user. The preview names the target's
plan and suspension state. A transfer is rejected while the project is deleting
or has a nonterminal deploy, rollback, or managed build. The administrator can
cancel or wait for that work and retry. This keeps a single operation from
beginning under one owner's plan and publishing under another's.

## Data model

### `project_members`

```text
project_id          text  FK projects(id) ON DELETE CASCADE
user_id             text  FK users(id) ON DELETE CASCADE
role                text  CHECK IN ('reader', 'collaborator', 'admin')
added_by_user_id    text  nullable, durable actor id
created_at          timestamp
updated_at          timestamp
PRIMARY KEY (project_id, user_id)
INDEX (user_id, project_id)
```

The service rejects a row whose `user_id` equals `projects.user_id`. Keeping the
owner out of this table makes ownership authoritative in one place and lets all
legacy projects acquire owner access automatically.

### `project_invitations`

This is separate from the existing installation-level `invitations` table,
which grants signup access but no project access.

```text
id                    text  PRIMARY KEY
project_id            text  FK projects(id) ON DELETE CASCADE
target_user_id        text  FK users(id) ON DELETE CASCADE
target_email_snapshot text  normalized lowercase address used for the invitation
role                  text  CHECK IN ('reader', 'collaborator', 'admin')
status                text  CHECK IN ('pending', 'accepted', 'declined', 'revoked', 'expired')
invited_by_user_id    text  durable actor id
accepted_by_user_id   text  nullable durable actor id
created_at            timestamp
expires_at            timestamp
accepted_at           timestamp nullable
revoked_at            timestamp nullable
revoked_by_user_id    text  nullable durable actor id
```

A partial unique index permits only one pending invitation per project and
target user. Creating an invitation first resolves the normalized email to
exactly one existing Platform user; no match is rejected. Reinviting updates
the intended role and extends expiry. Actor IDs deliberately do not use
deleting foreign keys because they are audit history.

### `project_ownership_periods`

```text
id                    text  PRIMARY KEY
project_id            text  FK projects(id) ON DELETE CASCADE
owner_user_id         text  durable billing identity
starts_at             timestamp
ends_at               timestamp nullable
changed_by_user_id    text  nullable installation-admin actor id
```

There is one open period per project. Existing projects receive an initial
period beginning at `projects.created_at`. A transfer closes that period and
opens the next one in the same transaction that updates `projects.user_id`.
These intervals resolve delayed usage events against the owner at the time the
event occurred.

Account usage queries intersect these ownership periods with each user's
billing window. Project usage remains a complete project history, while an
owner's aggregate contains only the portions billed to that owner. Request
events use their queue enqueue time, and AI queries start at the later of the
billing-period or ownership-period boundary. Managed Sandbox interval splitting
is deferred until that hard-disabled capability is reintroduced.

### Actor and billing attribution

Add `deployments.billing_user_id` and `deployments.initiated_by_user_id`.
Backfill `billing_user_id` from the current owner before transfers are enabled.
Daily deploy counts use `billing_user_id` instead of joining to the project's
current owner.

`builds.user_id` remains the billing owner for compatibility with the build
scheduler and its per-user locks. Automated GitHub builds use the current
project owner for `builds.user_id`; their GitHub authorization provenance
remains on the connection.

### Audit events

Add a small `project_access_events` table for invite, acceptance, decline, role
change, removal, and leave events. Store the project, durable actor ID, durable
subject ID, invitation email snapshot, previous/new role, action, and
timestamp. Ownership transfers additionally use the existing installation
operator event log so browser and CLI administrator actions retain the same
audit contract.

## Authorization architecture

Introduce one project-access service used by every authenticated project route:

```ts
type ProjectRole = 'reader' | 'collaborator' | 'admin' | 'owner'
type ProjectCapability =
  | 'read'
  | 'deploy'
  | 'configure'
  | 'settings'
  | 'members'
  | 'delete'

requireProjectCapability(db, projectId, actorUserId, capability)
  -> { project, role, owner }
```

The service first checks `projects.user_id`, then `project_members`. It returns
the owner account separately so callers cannot accidentally use the actor's
plan. Missing projects remain 404 and existing-but-inaccessible projects remain
403, matching the current API.

Replace all direct `project.user_id === context.get('user').id` checks in
projects, deploy, delete, secrets, domains, email, GitHub, usage, revalidation,
logs, builds, migrations, database, and binding-proxy verification. Replace
`getProjectsByUserId` with distinct helpers for owned projects and accessible
projects; billing, suspension, operator user views, and user deletion must keep
using the owned-project helper.

`GET /projects` returns owned and shared projects with `role` and a small owner
summary. A project-scoped deploy token still returns exactly its one scoped
project. The server, not the CLI, filters this list.

### Locks and credential revocation

Roles are never embedded as trusted JWT state. Full API, deploy, and prerender
credentials carry the actor ID and project scope, and every request resolves
current access from PostgreSQL.

Membership writes take the project row `FOR UPDATE` before changing a member.
Long or externally visible project mutations recheck the capability while
holding the same project lock immediately before commit or publish. In
particular, the final deploy transaction checks that the token subject still
has `deploy` capability as well as checking the bound build. Therefore:

- removal or downgrade that gets the lock first prevents publication;
- publication that gets the lock first completes before the membership change;
- a leaked unexpired deploy token cannot start new work after removal.

The binding proxy's existing internal `verify-owner` route checks the `deploy`
capability without changing its wire contract. Build-bound prerender
credentials retain their build-state check.

## Invitation flow

1. An owner or project administrator submits an existing user's registered
   email and the intended role.
2. The API normalizes the email and resolves exactly one registered Platform
   account. It rejects an unknown address, the owner, and an existing member.
3. Under the project lock, the API validates the role, creates or refreshes a
   pending invitation bound to the target user ID, and returns delivery status.
4. If platform email is configured, the API sends a notification link
   containing the invitation ID. The ID is a locator, not a bearer credential;
   only the authenticated target user can accept it. Without email, the
   invitation still appears in that user's pending-invitation list.
5. After login, one transaction locks the project and invitation, checks that
   the actor is still `target_user_id`, inserts `project_members`, marks the
   invitation accepted, and records the access event. Decline follows the same
   target-account check without creating membership.

The role is always read from the database invitation. Acceptance is single-use
and idempotent for its target user. Forwarding or guessing an invitation ID
does not grant access to another account. A project invitation never creates an
account, bypasses restricted signup, or adds a platform allowlist entry.

An invitation expires after seven days by default. Revoking it prevents later
acceptance. Resend uses the target account's current registered email, keeps the
same account binding, and follows the platform email rate limiter and a bounded
pending-invitation limit.

## API and user experience

### Project API

```text
GET    /projects/:id/members
GET    /projects/:id/invitations
POST   /projects/:id/invitations
POST   /projects/:id/invitations/:invitationId/resend
DELETE /projects/:id/invitations/:invitationId
PATCH  /projects/:id/members/:userId
DELETE /projects/:id/members/:userId
POST   /projects/:id/leave
GET    /me/project-invitations
POST   /project-invitations/:invitationId/accept
POST   /project-invitations/:invitationId/decline
```

Member listings are visible to all project roles. Invitation addresses and
mutation endpoints require `members`. `PATCH` accepts only a role. The owner is
returned in the member list with role `owner`, but owner mutations return 409.

### CLI

Add a `void project team` group:

```text
void project team list [--project <slug>]
void project team invite <email> --role <role> [--project <slug>]
void project team invitations [--project <slug>]
void project team role <user-id> <role> [--project <slug>]
void project team remove <user-id> [--project <slug>]
void project team revoke <invitation-id> [--project <slug>]
void project team leave [--project <slug>]
void project team pending
void project team accept <invitation-id>
void project team decline <invitation-id>
```

The existing project selector and repository link identify the project when
`--project` is absent. Project-scoped commands require a connected Void Platform
project and give a clear error for a direct Cloudflare target. The account-scoped
`pending`, `accept`, and `decline` commands use the connected Void Platform even
when the current directory targets Cloudflare directly. Project list output
gains a role column so shared projects are distinguishable.

The API-owned invitation landing route shows the CLI connection and acceptance
commands, so self-hosted installations do not require the optional dashboard.

### Installation administrator API

Add the shared operator service and expose it through both administrator
interfaces:

```text
POST /operator/v1/projects/:id/owner
{ "userId": "user_...", "dryRun": true | false }

void platform project owner <project-id> <user-id> [--plan | --yes]
```

The dry run reports current and new owner, both plans and suspension states,
the former owner's resulting project-admin role, active-work blockers, GitHub
connection provenance, and routing/counter updates. Apply follows the existing
operator audit and partial-failure contract and never retries an uncertain
mutation automatically.

## Ownership transfer and quota convergence

PostgreSQL is authoritative. The usage queue must resolve each event through
`project_ownership_periods` using the queue message timestamp, rather than
trusting the producer's `userId` hint or the project's current owner. This
correctly attributes an event that waited in the queue across a transfer.

UsageCounter state distinguishes already-billed totals from the set of projects
the user currently owns. Its initialization replaces that current-project set
from PostgreSQL instead of only merging slugs. Transfer control calls detach
the project from the former owner's counter and attach it to the new owner's
counter without moving already-billed totals. Delayed pre-transfer events may
still increment the former owner's total but may not reattach the project.

Counter writes that change project routing or AI blocks recheck current
ownership under the project lock. This prevents a stale former-owner Durable
Object from suspending, unsuspending, or deleting an AI block belonging to the
new ownership period.

The operator transfer performs these steps:

1. In one database transaction, lock the project then both users in stable ID
   order; reject active lifecycle work; close/open the ownership periods;
   update `projects.user_id`; remove the target's membership; add the former
   owner as project admin; and record the event.
2. Detach/attach the UsageCounter project mapping.
3. Republish the project-account and active routing entries with the new owner
   ID, plan limits, and suspension state. Usage ingestion already uses the
   database period, so stale producer hints cannot misbill requests.

If a post-commit external update fails, the database transfer remains committed
and the operator response identifies the partial state. A repeat apply resumes
the idempotent convergence steps. Application requests continue to be metered
to the database-authoritative owner during recovery.

GitHub connection authorization provenance may name any member who had
`settings` capability when the connection was created. Removing or
downgrading that authorizer below project administrator invalidates the
connection and cancels its active builds unless another project administrator
reauthorizes it first. A transfer normally preserves it because the former
owner becomes a project administrator. Webhook and Actions builds always
acquire capacity and select a build size from the current billing owner.

## User and project lifecycle

- Deleting a non-owner user cascades their memberships and project invitations
  targeting that account. It also invalidates GitHub connections whose proof
  depended on them.
- Deleting an owner keeps the existing behavior: owned projects are torn down
  before the account is removed. Being a member of other projects does not
  delete those projects.
- Deleting a project cascades members, invitations, ownership periods, and
  access events together with its other project data.
- Plan changes, billing rollovers, suspension, and restoration enumerate only
  owned projects, never projects on which the user is merely a member.
- Invitations remain bound to the resolved target user ID if that account's
  registered email changes. A resend uses the account's current email.
