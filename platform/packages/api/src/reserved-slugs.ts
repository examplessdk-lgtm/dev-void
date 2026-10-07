/**
 * Slugs that are EMAIL identities on the platform mail domain.
 *
 * A project's outbound `from` is `<slug>[+tag]@<EMAIL_SENDER_DOMAIN>` and
 * inbound mail to `<slug>[+tag]@` is dispatched into its worker, so owning a
 * slug owns that mailbox. `noreply` is the platform's own verification
 * sender, and `postmaster` / `abuse` / `bounce` / `security`
 * are the addresses recipients and mail providers treat as authoritative for
 * the whole domain. A project holding one of these could send mail that is
 * indistinguishable from ours, and would receive the bounces and replies to
 * it.
 *
 * `RESERVED_SLUGS` (`routes/projects.ts`) folds this set in, so no NEW
 * project can claim one. These five were reserved only when email shipped,
 * though, and the create-time check cannot reach a project registered
 * before that — so every consumer on the email path also refuses the slug
 * outright: the proxy refuses `/email/send` for it, and the inbound router
 * rejects mail addressed to it. Kept in its own module
 * so the proxy (`@voidcloud/api/reserved-slugs`) shares one list with the
 * api rather than carrying a copy that can drift.
 *
 * The rest of `RESERVED_SLUGS` (`www`, `api`, `mail`, `smtp`, …) is NOT
 * here: a hostname collision is not a mailbox. The certificate-authority
 * validation mailboxes (`administrator`, `hostmaster`, `webmaster`) were
 * added to that list later, on purpose for project creation only: an
 * existing project with one of those names keeps its mail.
 */
export const EMAIL_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'abuse',
  'bounce',
  'noreply',
  'postmaster',
  'security',
]);

/**
 * True when `slug` may not send or receive mail on the platform domain.
 * Callers pass a slug that is already lowercase: the api validates the
 * shape at create time, and the inbound router lowercases the recipient
 * before splitting it.
 */
export function isReservedEmailSlug(slug: string): boolean {
  return EMAIL_RESERVED_SLUGS.has(slug);
}
