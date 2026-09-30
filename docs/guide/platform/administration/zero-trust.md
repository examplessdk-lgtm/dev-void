---
outline: deep
---

# Project Zero Trust

## Protecting Projects with Zero Trust

Project protection puts Cloudflare Access in front of deployed project hostnames. It is separate from the Access gate on the platform API. Void protects project hostnames with one shared wildcard Access application. Projects made public receive an exact-host bypass application; protected projects with custom domains receive one exact Access application containing those domains.

Open **Zero Trust** in the administrator UI to configure, inspect, reconcile, or disable the feature. The project detail page shows desired and effective state and lets an installation administrator change the override. Void stores the API token encrypted and never shows it again.

The same workflow is available from the operator CLI:

```sh
void platform zero-trust status
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  --existing-projects public \
  --protect-new-projects \
  --token-stdin \
  --yes
```

Use `--plan` instead of `--yes` to inspect the change without applying it. Zero Trust always uses the Cloudflare account that hosts the platform.

`--existing-projects` is required when you enable Zero Trust and rejected once it is enabled. Later configuration changes keep each project's protection; use the project overrides below to change one project.

`void platform zero-trust status` shows the saved state. Add `--check` to also compare it with Cloudflare Access; the administrator UI offers the same check.

Use an API token scoped to the platform account with **Access: Apps and Policies Write** and **Access: Organizations, Identity Providers, and Groups Read**. Void validates the selected identity providers and reusable policies before publishing protection. It does not add these permissions to the platform runtime token.

Serve the platform API, proxy, and email gateway from hostnames outside the project application domain. Configuration is rejected when the project wildcard would cover one of them.

## Project Overrides

Owners and project administrators may opt a project out or back in:

```sh
void project zero-trust status
void project zero-trust public
void project zero-trust protect
void project zero-trust reconcile
```

Installation administrators can do the same with `void platform zero-trust project-status|project-protect|project-public|project-reconcile <project-id>`.

Deploys and rollbacks wait until the project's protection is settled. If one is refused, run `void project zero-trust reconcile` and retry.

## Limits

Cloudflare's default Access application limit is 500 per account. Void uses one wildcard application, up to one bypass application per public project, and up to one additional application per protected project that has custom domains. Include existing Access applications when checking the account limit before enabling this on a large installation. A protected project can have up to 100 custom domains.

## Recovery

A project never becomes public by mistake while a change is in progress. A platform operation skips a project that fails and finishes the rest; the project keeps its error and is retried by hourly maintenance. A project that was already protected stays protected until then; a project being newly protected keeps its previous access until the retry succeeds. Use `void platform zero-trust reconcile` after repairing permissions or account quota. Large operations may remain `configuring` or `disabling` after one request; the same reconcile command or scheduled maintenance resumes the saved operation. Disabling removes Void-managed applications and makes all projects public.

If the saved Cloudflare API token expires or is revoked during an operation, repeat `void platform zero-trust configure --token-stdin` with a replacement token and the same identity providers, policies, and project selections; omit `--existing-projects` unless the pending operation is the one that enables Zero Trust. Void resumes the saved operation, including an interrupted disable. Finish that operation before changing these settings.

If a selected identity provider or policy has been deleted, use `void platform zero-trust disable` to abandon the pending setup and remove its managed applications. This makes projects public. Once cleanup finishes, configure Zero Trust again with the replacement selections.
