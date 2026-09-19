// Generated email handlers import the wire protocol through Void so consumer
// projects do not need a direct dependency on @void/platform.
export {
  EMAIL_PROTOCOL_VERSION,
  encodeEmailActions,
  readEmailEnvelope,
} from '@void/platform/email-protocol';

const RECEIPT_VERIFICATION_DEADLINE_MS = 5_000;
const MAX_RECEIPT_VERIFICATION_BYTES = 2 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type ReceiptVerificationInput = {
  receipt: string;
  projectId: string;
  deploymentId: string;
  recipient: string;
};

type ReceiptVerifier = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

async function beforeDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error('email receipt verification timeout');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('email receipt verification timeout')), remaining);
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function readResponseJson(response: Response, deadline: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    response.headers.has('content-encoding') ||
    !response.body ||
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RECEIPT_VERIFICATION_BYTES))
  ) {
    throw new Error('invalid email receipt verification response');
  }
  const expectedLength = declaredLength === null ? null : Number(declaredLength);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RECEIPT_VERIFICATION_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(deadline, () => reader.read());
      if (chunk.done) {
        break;
      }
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > bytes.byteLength) {
        throw new Error('email receipt verification response too large');
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    // An uncooperative stream may never settle cancellation. Start cleanup,
    // but do not let it extend the hard request-and-response deadline.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  if (size === 0 || (expectedLength !== null && size !== expectedLength)) {
    throw new Error('invalid email receipt verification response length');
  }
  return JSON.parse(decoder.decode(bytes.subarray(0, size)));
}

/** Validate a gateway receipt without exposing the signing secret to the tenant worker. */
export async function verifyEmailReceiptThroughProxy(
  proxy: ReceiptVerifier,
  projectToken: string,
  input: ReceiptVerificationInput,
): Promise<boolean> {
  const deadline = Date.now() + RECEIPT_VERIFICATION_DEADLINE_MS;
  const controller = new AbortController();
  let response: Response | undefined;
  try {
    response = await beforeDeadline(deadline, () =>
      proxy.fetch('https://proxy/email/verify-receipt', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': projectToken },
        body: JSON.stringify(input),
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      return false;
    }
    const body = await readResponseJson(response, deadline);
    return (
      !!body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).valid === true
    );
  } catch {
    return false;
  } finally {
    controller.abort();
    void response?.body?.cancel().catch(() => {});
  }
}
