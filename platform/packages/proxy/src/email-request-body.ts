const EMAIL_REQUEST_DEADLINE_MS = 5_000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

async function beforeDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('email request timeout');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('email request timeout')), remaining);
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/** Bound public email request bodies before JSON parsing or authentication. */
export async function readEmailRequestJson(
  request: Request,
  maxBytes = 2 * 1024,
): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    request.headers.has('content-encoding') ||
    !request.body ||
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes))
  ) {
    void request.body?.cancel().catch(() => {});
    throw new Error('invalid email request body');
  }
  const expectedLength = declaredLength === null ? null : Number(declaredLength);
  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(1024, maxBytes));
  const deadline = Date.now() + EMAIL_REQUEST_DEADLINE_MS;
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(deadline, () => reader.read());
      if (chunk.done) {
        break;
      }
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > maxBytes) {
        throw new Error('email request body too large');
      }
      if (nextSize > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    // An uncooperative stream may never settle cancellation. Start cleanup,
    // but do not let it extend the hard request-body deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0 || (expectedLength !== null && size !== expectedLength)) {
    throw new Error('invalid email request body length');
  }
  return JSON.parse(decoder.decode(bytes.subarray(0, size)));
}
