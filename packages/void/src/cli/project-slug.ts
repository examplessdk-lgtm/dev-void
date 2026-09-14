/**
 * Longest slug the platform accepts — the same figure as the API's
 * `MAX_SLUG_LENGTH` and the runtime's `VALID_SLUG` (64-octet SMTP local-part
 * minus `+noreply`).
 */
export const MAX_SLUG_LENGTH = 56;

export function validateProjectSlug(value: string | undefined): string | undefined {
  const slug = (value ?? '').trim();
  if (slug.length === 0) {
    return 'Project slug is required.';
  }

  // Allows lowercase alphanumeric with interior dashes.
  const valid =
    slug.length === 1 ? /^[a-z0-9]$/.test(slug) : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
  if (!valid) {
    return 'Slug must be lowercase alphanumeric with dashes.';
  }

  // The slug is an email local-part prefix (`<slug>+noreply@`, `<slug>+<tag>@`)
  // and RFC 5321 caps a local-part at 64 octets; the API refuses anything over
  // 56 with the same rule (`MAX_SLUG_LENGTH`). Checked here too so the prompt
  // answers before the round trip.
  if (slug.length > MAX_SLUG_LENGTH) {
    return `Slug must be at most ${MAX_SLUG_LENGTH} characters (it forms the email sender <slug>+noreply@).`;
  }

  // Plan-based slug-length restrictions are enforced server-side so the check
  // can read the caller's current plan. The retry loop in create-project.ts
  // re-prompts when the server rejects.
  return undefined;
}
