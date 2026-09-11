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
 * Two hazards, one list:
 *   - shadowed platform binding: `__VOID_USER_ID` / `__VOID_PROJECT_SLUG`
 *     are emitted BEFORE user vars, so a user var of the same name wins
 *     and the sandbox runtime meters usage against the attacker's value.
 *   - shadowed user binding: `__VOID_PROXY` and friends are emitted AFTER,
 *     so a user's own var of that name never reaches their code.
 *
 * Hoisted out of `routes/deploy.ts` so `PUT /projects/:id/secrets/:name`
 * can reject a reserved name before it is encrypted and persisted —
 * otherwise the stored row only fails at the next deploy, far from the
 * action that caused it.
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
  '__PROJECT_ID',
  '__VOID_PROXY_TOKEN',
  '__VOID_USER_ID',
  '__VOID_PROJECT_SLUG',
  '__VOID_EMAIL_DOMAIN',
  'USAGE_EVENTS_QUEUE',
  'SEND_EMAIL',
  'ASSETS',
]);

export function isReservedBindingName(name: string): boolean {
  return RESERVED_BINDING_NAMES.has(name);
}
