export function useFrontmatter(): Record<string, unknown> {
  return {};
}

/**
 * @deprecated Internal to generated Markdown components and not available with
 * every framework adapter. Use `useFrontmatter()`. Removed in the next major
 * version.
 */
export const FrontmatterContext: Record<string, unknown> | null = null;

/**
 * @deprecated Internal to generated Markdown components and not available with
 * every framework adapter. Use `useFrontmatter()`. Removed in the next major
 * version.
 */
export function setFrontmatter(_frontmatter: Record<string, unknown>): void {}
