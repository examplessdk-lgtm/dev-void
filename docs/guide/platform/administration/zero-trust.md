---
outline: deep
---

# Project Zero Trust

Project Zero Trust puts Cloudflare Access in front of the hostnames of projects deployed to your platform, including custom domains. Visitors sign in with one of your identity providers before they reach a protected project. Each project can still be made public.

This is separate from the Access login and protection for the platform API. Projects deployed directly to Cloudflare are not affected.

## Requirements

- A Cloudflare Zero Trust organization in the account that hosts the platform, with the identity providers and reusable Access policies you want to use. Select at least one Allow policy that matches people by identity. Void rejects Bypass and Service Auth policies, and rules that allow Everyone or any service token.
- A Cloudflare API token for that account with **Access: Apps and Policies Write** and **Access: Organizations, Identity Providers, and Groups Read**. Void keeps it separate from the platform runtime token, stores it encrypted, and never shows it again.
- Free Access applications in the account. Cloudflare's default limit is 500 per account. Void uses one shared application for all project hostnames, one for each public project, and one for each protected project that has custom domains. Count the applications you already manage outside Void.
- Platform API, proxy, and email gateway hostnames outside the project application domain. Configuration is rejected when project protection would cover one of them.

## Enable Zero Trust

Open **Zero Trust** in the administrator UI, or use the operator CLI:

```sh
printf '%s' "$ACCESS_API_TOKEN" | void platform zero-trust configure \
  --identity-providers <id[,id...]> \
  --policies <id[,id...]> \
  --existing-projects public \
  --protect-new-projects \
  --token-stdin \
  --yes
```

- `--existing-projects protected|public` decides what happens to the projects that already exist. It is required when you enable Zero Trust.
- `--protect-new-projects` protects projects created from now on. Omit it to make new projects public.
- Use `--plan` instead of `--yes` to check the change without applying it.

To change the identity providers, policies, token, or new-project default later, run the same command without `--existing-projects`. Existing projects keep their protection; use the project overrides below to change one project.

## Check Status

```sh
void platform zero-trust status
void platform zero-trust status --check
```

`status` shows the saved settings, the current operation, and how many projects are protected, public, or waiting. `--check` also compares the settings with Cloudflare Access. In the administrator UI, use **Check with Cloudflare**.

## Project Overrides

Project owners and project administrators can protect a project or make it public. Readers can see its state.

```sh
void project zero-trust status
void project zero-trust protect
void project zero-trust public
void project zero-trust reconcile
```

`status` also tells you whether protection can be changed right now. Making a project public does not change the default for new projects.

Installation administrators can do the same from the project page in the administrator UI or with `void platform zero-trust project-status|project-protect|project-public|project-reconcile <project-id>`.

Deploys and rollbacks wait until a project's protection change is finished. If one is refused, run `void project zero-trust status` to see why; the owner or a project administrator can run `void project zero-trust reconcile` before you try again. A protected project can have up to 100 custom domains.

## Disable Zero Trust

```sh
void platform zero-trust disable
```

This removes the Access applications Void created and makes all projects public. Uninstalling the platform does not remove them, so disable Zero Trust first if you plan to uninstall.

## Recovery

A project never becomes public by mistake while a change is in progress.

- **Status stays `configuring` or `disabling`.** Large changes run in steps. Scheduled maintenance continues them within a few minutes, or run `void platform zero-trust reconcile`.
- **Status shows an error.** Fix the cause shown, such as token permissions or the application limit, then run `void platform zero-trust reconcile`. Otherwise Void retries every hour.
- **One project shows an error.** The rest of the change still finishes. Void retries the project every hour, or its owner or a project administrator can run `void project zero-trust reconcile`. Until then, a project that was already protected stays protected, and a project being newly protected keeps its previous access.
- **A new project could not be set up.** Creating the project still succeeds with a warning. Void retries every hour, or run `void project zero-trust reconcile`.
- **The saved API token expired or was revoked.** Run `void platform zero-trust configure --token-stdin` with a replacement token and the same identity providers, policies, and `--protect-new-projects` choice. Omit `--existing-projects`. Void continues the unfinished change, including an unfinished disable. Finish it before changing other settings.
- **A selected identity provider or policy was deleted.** Run `void platform zero-trust disable` to stop the unfinished setup and remove its applications. This makes projects public. Then configure Zero Trust again with the new selections.
