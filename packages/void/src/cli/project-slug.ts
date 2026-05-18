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

  // Plan-based slug-length restrictions are enforced server-side so the check
  // can read the caller's current plan. The retry loop in create-project.ts
  // re-prompts when the server rejects.
  return undefined;
}
