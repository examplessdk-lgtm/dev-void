/**
 * Escape JSON for embedding inside an inline `<script type="application/json">`
 * tag. Replaces `<`, `>`, `&`, U+2028, U+2029 with their `\uXXXX` JSON escape
 * sequences so the script tag cannot be closed early and the payload survives
 * `JSON.parse` on hydration.
 */
export function serializePageData(pageObj: unknown): string {
  return JSON.stringify(pageObj).replace(/[<>&\u2028\u2029]/g, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
