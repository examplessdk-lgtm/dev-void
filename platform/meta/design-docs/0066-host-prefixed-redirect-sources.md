---
title: Host-Prefixed Sources for Redirects and Rewrites
status: draft
created: 2026-04-22
---

# Host-Prefixed Sources for Redirects and Rewrites

## Context

Today, `_redirects` and `void.json` `routing.{redirects,rewrites,fallbacks}`
sources are path-only. Dispatch compiles the source into a regex and matches it
against `request.url`'s `pathname` (`packages/dispatch/src/redirects.ts:44`), so
a rule like:

```
https://lichter-io.void.app/*   https://www.lichter.io/:splat   301
```

silently never matches — the host prefix is part of the pattern, but the
pathname we match against is just `/foo`.

Netlify's `_redirects` supports host-prefixed sources as a way to express
"redirect everything from this domain to that domain" without relying on
per-host deploy config. Common uses:

- Domain consolidation (old marketing domain → new)
- Canonical host enforcement (`www.x.com` → `x.com`)
- Preview/staging → production redirects

This is a separate feature from external-origin rewrites (doc 0067, in progress)
and should ship independently. It's noted here because a user hit it while
writing a Netlify-style file and the silent-no-match behavior is confusing.

## Non-goals

- Matching against arbitrary request headers (e.g. `User-Agent`, `Cookie`).
- Protocol-aware matching (`http://` vs `https://`). Dispatch terminates TLS
  upstream; all requests that reach the worker are `https://`.

## Design questions to resolve

1. **Which hosts are considered "the project's own hosts"?** Dispatch already
   resolves a slug/custom-domain routing entry per request. A host-prefixed
   source only makes sense against the set of hosts bound to this deployment.
   A rule scoped to a host that isn't bound to the project is either a typo
   or wishful thinking — reject at validate time, or silently no-op at match
   time? Leaning "reject at deploy validate if the host doesn't appear in the
   project's domain set."

2. **Wildcards in the host portion.** Netlify allows `*.example.com/*`. Do we?
   Starter scope: literal host only. Can add later.

3. **Interaction with custom domains.** A user with `foo.com` + `www.foo.com`
   bound to the same project may want `https://www.foo.com/* https://foo.com/:splat 301!`.
   That should work. This means matching happens _after_ we know which domain
   served the request — which dispatch already does (`routingEntry` is looked
   up by host).

4. **Source syntax.** Keep the path-only shorthand working (most common case),
   accept an optional `https://host` prefix, reject `http://` (same reasoning
   as the external-rewrite plan).

## Proposed shape

Extend the parser in `packages/void/src/cli/headers.ts` (currently at
`parseRedirectsFile`, lines 142–231) to recognise an optional `https://host`
prefix on the source and split it into `{ host?: string, path: string }` on the
wire. The manifest `RedirectRule` gains an optional `host` field:

```ts
// packages/void/src/cli/types.ts
export type RedirectRule = {
  source: string; // path pattern, unchanged
  destination: string;
  status: number;
  host?: string; // NEW: literal host the rule is scoped to
};
```

Dispatch matching (`packages/dispatch/src/redirects.ts:21`) adds a host check:
if `rule.host` is set and doesn't equal the request `Host` header, skip the
rule. Otherwise fall through to the existing pathname match.

## Validation

- Host must be literal (no `*` in host portion, v1).
- Host must appear in the project's bound domain set (dispatch-side lookup at
  deploy validate time; the platform API already knows the domain set).
- Scheme must be `https://`. Reject `http://` and protocol-relative `//`.

## Testing

- Extend `framework/packages/void/test/unit/generate-headers-redirects.test.ts`
  with host-prefixed source parsing cases.
- Extend `packages/dispatch/test/unit/redirects.test.ts` with
  host-scoped-rule match/miss cases.
- Extend `packages/api/test/unit/*` deploy-validation tests to cover the
  "host not bound to project" rejection.

## Docs

- Update `framework/docs/guide/edge/redirects.md` with a "Domain-level
  redirects" section.
- Mention the relationship to external-origin rewrites (doc 0067): the source
  host identifies _where the request came from_, the destination URL
  identifies _where it goes_. They can be combined (`https://old.com/*  https://new.com/:splat 301!`).

## Out of scope

- Wildcard hosts (`*.example.com`).
- `http://` sources.
- Header- or cookie-based matching.
- Runtime-evaluated sources (e.g. geo, locale).
