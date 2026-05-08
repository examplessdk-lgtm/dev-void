---
outline: deep
---

# Deployment

Void apps run on Cloudflare's infrastructure but you don't need to use your own Cloudflare account. Our long term goal is to provide a simpler app-centric deployment experience similar to that of Vercel and Netlify. But right now, Void only supports deploying via the CLI or GitHub actions.

## CLI

### First deploy

```bash
void init               # can handle auth + project setup during onboarding
void deploy             # auto-detects app type, builds, deploys
```

If you skipped Void project setup during `void init`, you can still run `void auth login` manually. On first deploy, the CLI will prompt you to create or select a project if none is linked yet. The project link is saved to `.void/project.json` for subsequent deploys.

### Migrations

If your app uses Drizzle, `void deploy` runs migrations as part of the deploy flow:

1. Build the app
2. Read SQL migrations from `db/migrations/`
3. Fail if the schema has drifted ahead of the committed migrations
4. Apply pending migrations to the target database
5. Make the new deploy live

Deploy always uses checked-in migration files. If drift is detected, run `void db generate`, review the generated migration, commit it yourself, then rerun deploy. For the full database workflow and backend-specific details, see the [Database guide](./database.md).

### Flags

```bash
void deploy [--project <name>] [--dir <path>] [--spa]
```

| Flag               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `--project <name>` | Target a specific project by slug                 |
| `--dir <path>`     | Deploy a pre-built static directory (skips build) |
| `--spa`            | Use SPA mode instead of SSG for static deploys    |

### Project resolution

The CLI resolves which project to deploy to in this order:

1. `--project <name>` flag
2. `VOID_PROJECT` environment variable
3. Linked project in `.void/project.json`

If none match, the CLI prompts interactively.

### CI preparation

If your CI pipeline runs typechecking or other static analysis before deploy, run `void prepare` after install to generate the `.void/` artifacts without booting Vite.

### Environment variables

| Variable       | Purpose                          |
| -------------- | -------------------------------- |
| `VOID_TOKEN`   | Auth token (for CI, skips OAuth) |
| `VOID_PROJECT` | Project slug override            |

## GitHub Actions

You can deploy from a GitHub repo with a simple GitHub Actions workflow. Running `void init --github` will generate this as `.github/workflows/deploy.yml` in your project:

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: voidzero-dev/setup-vp@v1
        with:
          node-version: '22'
          cache: true
      - run: vp exec void deploy
        env:
          VOID_TOKEN: ${{ secrets.VOID_TOKEN }}
          VOID_PROJECT: my-app
```

To get a deploy token, run `void auth token` to copy it to your clipboard, then add it as a GitHub Actions secret.

## Other Targets

If you prefer to deploy directly to your own Cloudflare account instead of using Void's managed platform, see the [Cloudflare integration guide](../integrations/cloudflare.md).

To deploy to Node.js, Bun, or Deno instead of Cloudflare, set [`target`](../reference/config.md) in `void.json`. This builds a standalone server you can run anywhere, including Docker, Railway, and Fly.io. These targets do not have access to Void platform features such as D1, KV, R2, built-in auth, Workers AI, or cron scheduling. See the [Node.js, Bun, and Deno guide](../integrations/nodejs-bun-deno.md).
