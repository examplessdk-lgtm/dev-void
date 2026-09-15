---
title: Better Auth Integration
status: draft
created: 2026-03-09
---

# Better Auth Integration

> Historical design record. Status, checklists and examples describe the work
> when recorded. See the [design archive](./README.md) for current guides and
> the supported self-hosted platform.

## Summary

Replace Void's bespoke built-in auth implementation with a Better Auth-powered auth system for Void apps.

The goal is not to expose Better Auth as a config-heavy subsystem. The goal is to preserve the current Void feel:

- convention over configuration
- minimal onboarding
- auth "just works" when you use it
- advanced customization is available, but optional

In v1:

- scope to Void apps only
- support both D1 and PostgreSQL
- default to Better Auth's ecosystem path and mount auth at `/api/auth`
- keep `import { auth } from "void/client"` as the primary client UX
- expose `defineAuth()` only as an advanced escape hatch

This is a clean break from the current built-in auth. No backward-compatibility layer is part of the design.

## Motivation

The current auth feature is not a good foundation to continue growing:

- it conflates user identity and provider accounts into one table
- it splits sessions into `AUTH_KV`
- it lacks key lifecycle flows and session controls
- it has already drifted into doc/runtime inconsistency
- it overreaches on framework support

Better Auth already solves the hard parts we should not own:

- account and session modeling
- email/password flows
- OAuth providers
- rate limiting and trusted-origin support
- plugin-based expansion
- React-specific client support
- official Drizzle integration

The right product move is the same one we made with Drizzle: build on the ecosystem leader instead of maintaining our own parallel abstraction.

## Goals

- Make Better Auth the auth engine for Void apps.
- Keep auth convention-first and nearly zero-config by default.
- Support both D1 and PostgreSQL in v1 using the built-in Drizzle story.
- Preserve the existing `void/client` auth UX.
- Default to Better Auth's `/api/auth` path for ecosystem compatibility.
- Keep advanced Better Auth customization available through `defineAuth()`.

## Non-Goals

- First-class meta-framework support in v1.
- A backward-compatible bridge from the current auth implementation.
- Requiring users to hand-configure base paths, binding names, or database adapters.
- Re-exporting every Better Auth feature under custom Void APIs.
- Building custom auth flows outside Better Auth's model.

## Product Shape

### Default Experience

Auth should work by convention when the user uses auth APIs.

Default conventions:

- mount path: `/api/auth`
- database: the app's existing Void-managed database
- database adapter: chosen automatically from the app's current D1 or PostgreSQL setup
- email/password: enabled by default
- email delivery hooks: available for app-owned provider wiring when needed
- social providers: enabled by presence of conventional env vars
- client base URL: same-origin by default

The user should not need to think about:

- auth route path
- database bindings
- session storage
- Better Auth adapter choice
- client factory setup
- platform-managed email delivery in v1

### Escape Hatch

`defineAuth()` exists for advanced configuration only.

Examples of advanced use:

- adding Better Auth plugins
- customizing provider config beyond conventions
- changing trusted origins behavior
- overriding default Better Auth options
- custom client creation needs that go beyond `void/client`

If a user never needs those things, they should not need an `auth.ts` file at all.

## User Experience

### Server

Existing server-side ergonomics stay intact for Void apps:

```ts
import { requireAuth } from 'void/auth';

export const GET = defineHandler((c) => {
  const user = requireAuth(c);
  return { id: user.id, email: user.email };
});
```

Optional helpers should remain:

- `getUser()`
- `getSession()`
- `requireAuth(c)`

These are convenience wrappers over Better Auth-backed request state, not a separate auth system.

### Client

The primary client UX stays:

```ts
import { auth } from 'void/client';
```

`void/client` becomes a virtual module that wires Better Auth's client under the hood.

Default behavior:

- export `auth` as a ready-to-use client instance
- export `createAuthClient` for advanced cases
- use `better-auth/react` instead of `better-auth/client` when `@void/react` is detected
- otherwise use the generic Better Auth client

This preserves the simple Void import while still aligning with Better Auth's framework-specific client packages.

### Scaffolding

If we scaffold auth-related files, they go under `void gen`, not `void auth`.

Possible use:

```bash
void gen auth
```

This should generate optional convenience files only, for example:

- a starter auth page
- an advanced `auth.ts` template
- a local `auth-client.ts` example for custom plugin use

Scaffolding is not the activation mechanism. Conventions are.

## Design

### 1. Activation by Usage, Not by Explicit Auth Config

We should preserve the current "auth turns on when you use it" model.

Auth is considered active when the app uses one of:

- `import { auth } from "void/client"`
- `import { createAuthClient } from "void/client"`
- `import { getUser } from "void/auth"`
- `import { getSession } from "void/auth"`
- `import { requireAuth } from "void/auth"`

This is the equivalent of today's import-based auth activation, but the underlying implementation is Better Auth instead of generated custom handlers.

### 2. Convention-Generated Better Auth Config

When auth is active and no `auth.ts` exists, Void generates a default Better Auth config internally.

That default config should derive:

- base path from the framework convention (`/api/auth`)
- adapter from the app's existing database mode
- provider settings from conventional env vars
- trusted-origin defaults from local/dev/prod conventions

The default config should be good enough for the common case without additional files.

### 3. `defineAuth()` Extends Defaults

`defineAuth()` should not require users to rebuild the full config from scratch.

Preferred shape:

```ts
import { defineAuth } from 'void/auth';
import { username } from 'better-auth/plugins';

export default defineAuth(({ defaults, env }) => ({
  ...defaults,
  plugins: [...defaults.plugins, username()],
}));
```

Key properties:

- users start from Void's convention-generated defaults
- advanced config is additive and intentional
- Void keeps ownership of the default wiring

### 4. Runtime Wiring

For Void apps, the generated Hono app should:

1. resolve the effective Better Auth config
2. create the Better Auth instance for the current environment
3. mount the Better Auth handler at `/api/auth/*`
4. run request middleware that resolves session/user state and stores it on context and AsyncLocalStorage

Pseudo-shape:

```ts
app.use('*', async (c, next) => {
  const auth = createVoidAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set('session', session?.session ?? null);
  c.set('user', session?.user ?? null);
  await authContext.run({ session: session?.session ?? null, user: session?.user ?? null }, next);
});

app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => {
  const auth = createVoidAuth(c.env);
  return auth.handler(c.req.raw);
});
```

There is no custom codegen for register/login/provider routes anymore. Better Auth owns that surface.

### 5. Database Strategy: D1 and PostgreSQL in v1

Built-in Drizzle support for both D1 and PostgreSQL already exists. Auth should use that in v1.

That means:

- D1 apps: Better Auth uses the app's D1-backed Drizzle setup
- PostgreSQL apps: Better Auth uses the app's Postgres-backed Drizzle setup

Void chooses the right adapter automatically from the app's existing database mode.

The user does not configure:

- binding names
- adapter packages
- dialect selection
- separate auth storage

This keeps auth aligned with the rest of the framework's database story.

### 6. Session Storage

`AUTH_KV` goes away.

Sessions should live in the same database system as the rest of Better Auth's tables through the selected Better Auth + Drizzle path.

Benefits:

- one storage model
- one migration story
- no special auth-only KV dependency
- consistent behavior across D1 and PostgreSQL

### 7. Provider Conventions

Social provider enablement should stay convention-based like the original auth implementation.

Initial convention set:

- `GITHUB_OAUTH_ID`
- `GITHUB_OAUTH_SECRET`
- `GOOGLE_OAUTH_ID`
- `GOOGLE_OAUTH_SECRET`

If the matching env vars exist, the provider is enabled in the generated Better Auth config.

`defineAuth()` can override or extend this behavior for advanced users.

### 8. Email Hooks

Flows that require outbound email should be supported in v1 through user-supplied provider hooks.

This includes flows such as:

- email verification
- password reset
- any future magic-link or email-OTP flows we choose to expose

The key v1 rule is:

- Better Auth owns the hook surface
- the app owns the actual email provider integration
- Void does not provide integrated email delivery yet

That means:

- basic email/password sign-up and sign-in should work without a mail provider
- flows that send email require the app to wire a provider
- the wiring point should be `defineAuth()` because this is an advanced configuration case

Example shape:

```ts
import { defineAuth } from 'void/auth';
import { sendEmail } from '~/lib/email';

export default defineAuth(({ defaults }) => ({
  ...defaults,
  emailVerification: {
    ...defaults.emailVerification,
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Verify your email',
        html: `<a href="${url}">Verify email</a>`,
      });
    },
  },
  emailAndPassword: {
    ...defaults.emailAndPassword,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your password',
        html: `<a href="${url}">Reset password</a>`,
      });
    },
  },
}));
```

This keeps the default Void auth setup minimal while still giving apps a clear way to use Resend, SES, SendGrid, Postmark, or any other provider.

Later, when Void provides integrated email sending as a platform feature, that should plug into the same Better Auth hooks rather than introducing a different email API.

### 9. Client Virtual Module

`void/client` should become the canonical auth client entrypoint.

Exports:

- `auth`
- `createAuthClient`

Resolution behavior:

- if `@void/react` is present, back `auth` and `createAuthClient` with `better-auth/react`
- otherwise use the generic Better Auth client

This gives us:

- a minimal, stable import path for users
- the correct React-specific client when needed
- escape hatches for plugin-aware custom clients

### 10. Mount Path

Default auth mount path is `/api/auth`.

Reasons:

- aligns with Better Auth ecosystem expectations
- reduces friction with Better Auth docs, examples, and client defaults
- avoids carrying the old `/auth` shape forward for compatibility reasons we no longer need

If a user wants a different path, that is an advanced `defineAuth()` concern, not the default path.

### 11. Migrations

Auth should use the same migration discipline as the rest of the framework.

Requirements:

- auth tables are part of the app's database story
- local dev can bootstrap auth tables automatically
- deploy runs auth-related migrations before traffic flips
- D1 and PostgreSQL both work in the same product version

Implementation detail can follow one of two routes:

- Better Auth-driven schema generation integrated into our Drizzle pipeline
- Better Auth runtime/schema APIs composed with our existing migration flow

The important product requirement is not which internal mechanism we pick. The important requirement is that users experience one coherent DB + auth setup, not separate systems.

### 12. Meta-Framework Scope

Meta-framework support is out of scope for v1.

In v1:

- Void only ships first-class Better Auth integration for Void apps
- meta-framework users should use Better Auth's official framework integrations directly
- Void docs may mention that path, but Void does not add framework-specific auth glue in this phase

This keeps the first release focused and avoids repeating the current over-claimed support matrix.

## Testing

Required coverage for v1:

- unit tests for auth activation and virtual-module resolution
- unit tests for D1 and PostgreSQL adapter selection
- unit tests for env-based provider enablement
- unit tests for `defineAuth()` override/merge behavior
- unit tests for user-wired email hook configuration
- integration tests for email/password sign-up, sign-in, sign-out, and session fetch
- integration tests for both D1 and PostgreSQL apps
- integration tests for at least GitHub and Google provider wiring
- integration tests for `void/client` default exports and `createAuthClient`

No meta-framework auth tests are required in v1 because that surface is out of scope.

## Rollout Plan

### Phase A: Core Better Auth Integration

- replace bespoke auth runtime with Better Auth
- mount auth at `/api/auth`
- preserve `void/auth` server helpers
- preserve `void/client` as the primary client import
- remove `AUTH_KV`

### Phase B: Convention Layer

- implement provider env inference
- implement automatic D1/PG adapter selection
- make the default setup work without `auth.ts`
- support app-owned email provider wiring through `defineAuth()`

### Phase C: Escape Hatches

- add `defineAuth()` as an override layer on top of defaults
- expose `createAuthClient`
- add `void gen auth` for optional starter files

### Phase D: Docs and Cleanup

- rewrite auth docs around Better Auth
- remove old `/auth` guidance
- remove old auth schema/password/session implementation
- remove old compatibility assumptions from guides and prompts

## Alternatives Considered

### Keep the Current Auth and Expand It

Rejected.

That path keeps us in the business of maintaining our own auth framework.

### Make `defineAuth()` Mandatory

Rejected.

It makes the setup too configuration-heavy and loses the convention-first feel that made the original auth feature attractive.

### Keep Meta-Framework Support in v1

Rejected.

It broadens scope at exactly the wrong time. Better Auth already has official framework integrations, so we do not need to solve that in the first Void-backed release.

## Open Questions

- Should auth activation stay purely import-based, or should `void gen auth` also leave behind a small explicit marker file?
- Should provider inference stay limited to GitHub and Google at launch, or should we include more providers on day one?
- Is the React-specific client swap in `void/client` enough, or do we also want adapter-specific helpers elsewhere?
- What is the cleanest internal way to compose Better Auth schema management with our existing Drizzle-first migration flow?
- How much email-provider convenience should we add on top of Better Auth hooks without turning email setup into another custom Void subsystem?

## Recommendation

Proceed with a Void-app-only, convention-first Better Auth integration in v1.

The core rule for implementation should be:

- Better Auth owns auth behavior
- Void owns the defaults, detection, and wiring
- `defineAuth()` and `createAuthClient` exist for customization, not for day-one setup

## References

- Better Auth intro: https://better-auth.com/docs/introduction
- Better Auth Hono integration: https://better-auth.com/docs/integrations/hono
- Better Auth Drizzle adapter: https://better-auth.com/docs/adapters/drizzle
- Better Auth email/password: https://better-auth.com/docs/authentication/email-password
- Better Auth session management: https://better-auth.com/docs/concepts/session-management
- Better Auth rate limiting: https://better-auth.com/docs/concepts/rate-limit
- Better Auth options: https://better-auth.com/docs/reference/options
- Better Auth changelog: https://better-auth.com/changelog
- Better Auth 1.5 release: https://better-auth.com/blog/1-5
