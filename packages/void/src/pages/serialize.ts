import { escapeScriptJson } from './script-json.ts';

/**
 * Escape JSON for embedding inside an inline `<script type="application/json">`
 * tag. Replaces `<`, `>`, `&`, U+2028, U+2029 with their `\uXXXX` JSON escape
 * sequences so the script tag cannot be closed early and the payload survives
 * `JSON.parse` on hydration.
 */
export function serializePageData(pageObj: unknown): string {
  return escapeScriptJson(JSON.stringify(pageObj));
}
