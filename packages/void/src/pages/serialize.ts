const UNSAFE_SCRIPT_CHARS = /[<>&\u2028\u2029]/g;

function escapeScriptJson(json: string): string {
  return json.replace(UNSAFE_SCRIPT_CHARS, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/**
 * Escape JSON for embedding inside an inline `<script type="application/json">`
 * tag. Replaces `<`, `>`, `&`, U+2028, U+2029 with their `\uXXXX` JSON escape
 * sequences so the script tag cannot be closed early and the payload survives
 * `JSON.parse` on hydration.
 */
export function serializePageData(pageObj: unknown): string {
  return escapeScriptJson(JSON.stringify(pageObj));
}

/** Same escaping as `serializePageData`; values JSON cannot represent (`undefined`, functions) become `null`. */
export function safeJsonStringify(value: unknown): string {
  return escapeScriptJson(JSON.stringify(value) ?? 'null');
}
