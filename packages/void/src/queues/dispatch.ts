/**
 * Emit the queue-name resolver used by generated native workers and framework
 * wrappers. Hosted relays send the exact logical name. Native Queue events may
 * expose a project-prefixed physical name, so fallback matching selects the
 * unique longest known `-name` suffix. Unknown or ambiguous inputs fail closed.
 */
export function generateQueueResolverSource(queueNames: ReadonlyArray<string>): string {
  return `const __queueNames = ${JSON.stringify(queueNames)};
function __resolveQueueIndex(queueName) {
  if (typeof queueName !== "string") return -1;
  const exact = __queueNames.indexOf(queueName);
  if (exact !== -1) return exact;
  let match = -1;
  let matchLength = -1;
  for (let i = 0; i < __queueNames.length; i++) {
    const name = __queueNames[i];
    if (!queueName.endsWith("-" + name)) continue;
    if (name.length > matchLength) {
      match = i;
      matchLength = name.length;
    } else if (name.length === matchLength) {
      match = -1;
    }
  }
  return match;
}`;
}
