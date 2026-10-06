/**
 * Binding names a user worker upload may not declare — as a manifest var
 * (`manifest.vars`) or as a project secret.
 *
 * The deploy pipeline appends the platform's own bindings to the same
 * `metadata.bindings` array the user's vars and secrets go into, and
 * Cloudflare resolves duplicate names last-wins. Depending on where a
 * platform binding sits in that array, a user declaration either silently
 * shadows the platform value or is silently shadowed by it — both are
 * unexplainable at runtime. So the whole set is rejected up front.
 *
 * Platform proxy and identity bindings must not collide with user values.
 * Retired Sandbox identity and queue names remain reserved so older runtime
 * conventions cannot turn into ambiguous user bindings after an upgrade.
 *
 * `PUT /projects/:id/secrets/:name` also checks this set so a reserved name
 * is rejected before it is encrypted and persisted — otherwise the stored
 * row only fails at the next deploy, far from the action that caused it.
 *
 * `SEND_EMAIL` is reserved even though user workers no longer receive a
 * per-worker `[[send_email]]` binding (the proxy holds the account-level
 * one). It keeps the name free for custom-domain email and stops a user
 * binding from colliding with framework code that still references it.
 *
 * INVARIANT: every binding name the deploy pipeline injects must be a
 * member of this set. `test/unit/reserved-bindings.test.ts` pins that
 * against the real producers so the list cannot silently drift.
 */
export const RESERVED_BINDING_NAMES: ReadonlySet<string> = new Set([
  '__VOID_PROXY',
  '__VOID_SANDBOX',
  '__PROJECT_ID',
  '__VOID_PROXY_TOKEN',
  '__VOID_USER_ID',
  '__VOID_PROJECT_SLUG',
  '__VOID_EMAIL_DOMAIN',
  '__VOID_EMAIL_DEPLOYMENT_ID',
  'USAGE_EVENTS_QUEUE',
  'SEND_EMAIL',
  'ASSETS',
]);

export function isReservedBindingName(name: string): boolean {
  return RESERVED_BINDING_NAMES.has(name);
}
