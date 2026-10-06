const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;

/**
 * Generate a prefixed random ID.
 * Example: generateId("proj") → "proj_a1b2c3d4e5f6"
 */
export function generateId(prefix: string): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `${prefix}_${id}`;
}

const PROJECT_ID = new RegExp(`^proj_[${ALPHABET}]{${ID_LENGTH}}$`);

/**
 * Whether `value` has the shape `generateId('proj')` produces. Callers check
 * this before verifying a token bound to a project id, so no other string
 * reaches the MAC check.
 */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value);
}
