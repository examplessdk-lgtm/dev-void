---
outline: deep
---

# Platform Administration

`void platform` lets you manage the people and apps on a Void platform from your terminal. You can give teammates access, inspect their projects, follow deployment logs, and check the platform's health.

These commands require an administrator account. If you're setting up a platform for the first time, start with [Self-host a Void Platform](./self-hosted-platform.md).

## Signing In

Connect to your platform's API URL, then sign in as an administrator:

```sh
void connect https://platform.example.com --no-login
void platform auth login
```

The first command saves the connection. The second opens your browser to sign in and saves an administrator session in your system keychain. Sessions last for one hour and are stored separately for each platform.

You can check which account is signed in at any time:

```sh
void platform auth status
```

This shows your account, the session's expiry, and the features available on the platform. To end the session, run `void platform auth logout`.

## Choosing a Platform

If you manage more than one platform, list your connections and choose a default:

```sh
void platform list
void platform use <connection-id>
```

You can also select a platform for a single command with `--connection`:

```sh
void platform user list --connection <connection-id>
```

Use an ID or URL from the connection list. Administrative commands use this selection even when you run them inside an app with a different deployment destination.

## Giving People Access

A newly installed platform restricts signup to approved identities. To let a teammate join with GitHub, add their login to the allowlist:

```sh
void platform signup allow github teammate
```

Void shows the change and asks you to confirm it. The teammate can then run `void connect` with the platform's URL and sign in.

You can allow an email address or a whole email domain in the same way:

```sh
void platform signup allow email teammate@example.com
void platform signup allow email '*@example.com'
```

Email patterns apply across the platform's sign-in providers. Quote a domain pattern so your shell passes the `*` to Void.

To invite someone else by email, use:

```sh
void platform invitation send alex@example.org
```

An invitation grants signup access and sends an email when the platform has email delivery configured. If delivery is unavailable or fails, the result tells you; the person can still join using the platform's URL.

Inspect the current access settings and invitations with:

```sh
void platform signup show
void platform invitation list
```

`void platform signup open` allows anyone to sign up. Use `void platform signup restrict` to require an allowlist match again. Removing an allowlist entry affects future signup; it does not suspend an existing account.

## Managing Users and Projects

Start by finding the user you want to inspect:

```sh
void platform user list --search teammate
void platform user show <user-id>
```

Use the ID from the list in the second command. The detail view shows the user's projects and usage. You can change their plan or list just their projects:

```sh
void platform user plan <user-id> pro
void platform project list --user <user-id>
void platform project show <project-id>
```

Project details include resources, domains, and recent builds and deployments. The [command reference](../reference/cli.md#operator-commands) also covers suspending and restoring users, deleting projects, and removing accounts.

## Previewing Changes

Commands that change the platform show the affected objects before asking for confirmation. To inspect a change without applying it, add `--plan`:

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --plan
```

The preview shows which account will be suspended and the effect on its projects. Run the command again without `--plan` to confirm interactively, or use `--yes` when the change is ready to apply:

```sh
void platform user suspend <user-id> --reason "Investigating unexpected traffic" --yes
```

Scripts must use `--yes` to apply these changes. Authentication commands run directly and do not use `--plan` or `--yes`. After a change, `void platform system events` shows the administrator, affected objects, and recorded outcome.

Changes can take longer when an account owns many resources. Requests that change the platform allow five minutes by default; use `--timeout` to set a different limit in seconds:

```sh
void platform user delete <user-id> --timeout 600 --plan
```

If a request times out or loses its connection, some work may already have finished. Check the affected objects and `system events` before retrying. Void reports partial results when it can and does not automatically repeat the change.

## Following Logs

To investigate a deployment, find its ID and follow its runtime logs:

```sh
void platform deployment list --project <project-id>
void platform deployment logs <deployment-id> --since 10m --follow
```

Runtime logs include application messages, exceptions, and HTTP status codes. Without `--follow`, the command reads a page of historical logs. Use `--since` to choose a duration, an ISO date, or a timestamp in milliseconds.

Logs can become available after a request finishes. Following checks a five-minute overlap to pick up delayed records without printing them again. Records delayed longer than that may need a later historical query.

Build logs use the build's ID:

```sh
void platform build logs <build-id> --follow
```

Following waits for the final logs before stopping, including diagnostics written after the build's status changes. For a GitHub Actions build, the command gives you the URL of its logs.

## Checking the Platform

Use the overview to see recent activity, or run a health check to test the platform's services and database:

```sh
void platform system overview
void platform system health
```

Health checks use the services configured for the selected platform. An unhealthy result exits with a nonzero status, so the same command can be used in a script.

Self-hosted installations use `void platform upgrade`, `repair`, `disable`, and `enable` to manage their Workers. See [platform maintenance](./self-hosted-platform.md#resume-repair-recover-and-upgrade). Void Cloud operators can also inspect Worker versions and roll them back with the [`worker` commands](../reference/cli.md#operator-workers).

## Using Scripts

Add `--json` to read a command's result from another program:

```sh
void platform user list --page 1 --limit 50 --json
void platform system health --json
```

Results go to standard output. Command errors go to standard error as JSON and exit with a nonzero status. With `--follow`, each log response is a separate JSON line.

For CI, supply `VOID_OPERATOR_TOKEN` from your secret manager and choose its platform explicitly:

```sh
export VOID_API_URL=https://platform.example.com
# Supply VOID_OPERATOR_TOKEN from your secret manager.
void platform system health --json
```

To obtain a one-hour administrator token from an existing full API login session, pipe that session token to `auth token --token-stdin`:

```sh
printf '%s' "$VOID_TOKEN" | void platform auth token --token-stdin
```

The API login session must belong to an administrator on `VOID_API_URL`. This prints the new operator token to standard output. `auth login --token-stdin` performs the same exchange and saves the result in the system keychain instead. See [operator authentication](../reference/cli.md#operator-authentication) for the full command syntax.
