---
outline: deep
---

# Project Collaboration

A project hosted on a Void platform can have one owner and additional readers, collaborators, and project administrators. Team access is a platform feature; it is not available for projects deployed directly to Cloudflare.

## Roles

| Role                  | Access                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reader                | View the project, usage, resources, deployments, builds, logs, and member roster. Cannot deploy.                          |
| Collaborator          | Reader access plus deploy, rollback, cancellation, migrations, secrets, database configuration, and deploy prerequisites. |
| Project administrator | Collaborator access plus domains, email destinations, GitHub configuration, invitations, roles, and member removal.       |
| Owner                 | Project administrator access plus project deletion.                                                                       |

The owner's plan, limits, and suspension state govern the project. A member's
own plan does not change the project's available usage, and acting through a
collaborator does not bypass an owner suspension. A project administrator is
not an installation administrator and receives no platform-wide access.

## Invite a Registered User

An owner or project administrator can invite someone by the email address registered to their existing account on the same platform:

```sh
void project team invite teammate@example.com --role collaborator
```

Pass `--project <slug>` to manage a project other than the linked project. An unknown email is rejected. A project invitation neither creates an account nor adds the address to a restricted-signup allowlist.

List the roster and sent invitations with:

```sh
void project team list
void project team invitations
```

## Respond to an Invitation

The invited user can see invitations addressed to their account and respond using the invitation ID:

```sh
void project team pending
void project team accept <invitation-id>
# or
void project team decline <invitation-id>
```

An invitation is bound to the registered account. Forwarding its ID does not let another user accept it.

These three invitation-response commands are account-scoped and do not depend
on the current project's deploy target. They can run from a direct Cloudflare
project directory when it resolves your connected Void platform account.

## Change or Remove Access

Owners and project administrators can change any non-owner member or revoke a pending invitation:

```sh
void project team role <user-id> reader
void project team remove <user-id>
void project team revoke <invitation-id>
```

A non-owner member can leave with `void project team leave`. The owner cannot leave; an installation administrator must [transfer ownership](./platform-administration.md#transferring-project-ownership) first.
