/** JSON representation of the native R2 put precondition options. */
export type RemoteR2Conditional =
  | Array<[string, string]>
  | (Omit<R2Conditional, 'uploadedBefore' | 'uploadedAfter'> & {
      uploadedBefore?: string;
      uploadedAfter?: string;
    });

export function serializeR2Conditional(value: R2Conditional | Headers): RemoteR2Conditional {
  if (value instanceof Headers) {
    return Array.from(value.entries());
  }
  return {
    ...value,
    uploadedBefore: value.uploadedBefore?.toISOString(),
    uploadedAfter: value.uploadedAfter?.toISOString(),
  };
}

export function parseR2Conditional(value: unknown): R2Conditional | Headers {
  if (Array.isArray(value)) {
    if (
      !value.every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          pair.every((item) => typeof item === 'string'),
      )
    ) {
      throw new Error('Invalid R2 conditional headers');
    }
    return new Headers(value as Array<[string, string]>);
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid R2 conditional options');
  }
  const result: R2Conditional = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'etagMatches' || key === 'etagDoesNotMatch') {
      if (typeof entry !== 'string') {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = entry;
    } else if (key === 'uploadedBefore' || key === 'uploadedAfter') {
      if (typeof entry !== 'string' || !Number.isFinite(Date.parse(entry))) {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = new Date(entry);
    } else if (key === 'secondsGranularity') {
      if (typeof entry !== 'boolean') {
        throw new Error(`Invalid R2 condition: ${key}`);
      }
      result[key] = entry;
    } else {
      throw new Error(`Unsupported R2 condition: ${key}`);
    }
  }
  return result;
}
