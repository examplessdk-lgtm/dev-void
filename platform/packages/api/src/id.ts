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
 * Whether `value` has the shape `generateId('proj')` produces. The project
 * token is an HMAC over the project id under the same key that signs login
 * JWTs and OAuth state, so callers check this before verifying the token:
 * any other string (such as a JWT's `header.body`) must not authenticate.
 */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value);
}
