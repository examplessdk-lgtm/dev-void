# @voidcloud/dashboard

Optional authentication frontend for a Void platform, built as a React Pages
mode app. The administrator UI is served by the API Worker.

## Architecture

- **React Pages mode** - `voidPlugin()` + `voidReact()`, SSR with client hydration.
- **Auth** - OAuth (GitHub/Google) via the platform's `/auth/login` flow. The JWT is
  stored in an httpOnly cookie (`void_token`). Middleware validates the token with
  `GET /me`.
- **Styling** - Tailwind CSS v4 with dashboard-local styles, fonts, assets,
  and React components in `ui/`.

## Pages

| Route            | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `/login`         | OAuth buttons (GitHub, Google)           |
| `/auth/callback` | Exchanges the login response for a token |
| `/`              | Minimal authenticated confirmation page  |
| `/logout`        | Clears cookie, redirects to login        |

## Local Development

Start with an API you run locally. From the repository root, with PostgreSQL
running and its client tools on your path:

```sh
vp run build:core
vp run --filter @voidcloud/api setup --admin-email dev@example.com
vp run --filter @voidcloud/api dev --local --enable-containers=false --host localhost --port 8787
```

In another terminal:

```sh
vp run --filter @voidcloud/dashboard dev
```

Setup creates ignored `.dev.vars` files. Set the dashboard's
`platform/packages/dashboard/.dev.vars` to use the local API:

```dotenv
API_URL=http://localhost:8787
SITE_DOMAIN=apps.example.com
```

Open the Vite URL and choose **Dev login (local API)**. That path requires the
API's explicit development bypass and the dashboard's login nonce. Operator
CLI authentication remains separate from the browser development bypass.

To use an API that you operate, set `API_URL` to its public origin and
`SITE_DOMAIN` to its application domain. If Cloudflare Access protects it,
set `CF_ACCESS_APP_URL` to that same HTTPS origin. The local token helper uses
`cloudflared` to refresh its Access session before Vite starts; automation can
supply `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` instead.

See [Platform Development](../../../docs/guide/platform-development.md) for the
full setup and source-runtime workflow. The core platform installer does not
install the dashboard; running this app locally does not add it to an installation.

## Source Layout

```text
lib/
  api.ts                    # Typed authentication API fetch helpers
ui/
  components/               # Dashboard header and footer
  context/                  # Logo configuration
  styles/                   # Tailwind tokens, reset, shell and button styles
  assets/                   # Void logos and dashboard backgrounds
  fonts/                    # APK Protocol, KH Teka Mono, and Inter
middleware/
  01.auth.ts                # void_token validation through /me
pages/
  layout.tsx                # Authenticated shell with logout
  login.tsx                 # OAuth login buttons
  login.server.ts           # Builds provider login URLs
  logout.tsx
  logout.server.ts          # Cookie clear + redirect
  index.tsx                 # Authenticated confirmation page
  index.server.ts           # Session user from middleware
  auth/
    callback.tsx
    callback.server.ts      # OAuth callback token/code exchange
```

## Inter license

The `ui/fonts/inter-*.woff2` files are copyright (c) 2016 The Inter Project
Authors and are distributed under the SIL Open Font License 1.1. The full
copyright notice and license are included in
[`ui/fonts/Inter-LICENSE.txt`](./ui/fonts/Inter-LICENSE.txt). Keep that file with
copies of the Inter fonts. This notice applies specifically to Inter.
