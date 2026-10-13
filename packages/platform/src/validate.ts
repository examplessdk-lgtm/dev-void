export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  record(value, label);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

/** Nonblank text of at most `maximum` characters, without control characters. */
export function isPrintableText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= maximum &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export function isSandboxDrainProtocol(value: unknown): value is 0 | 1 | 2 | 3 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export function isUsageProtocolVersion(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

export function isSourceRevision(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}
