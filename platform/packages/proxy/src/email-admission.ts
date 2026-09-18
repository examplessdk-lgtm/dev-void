import type { Env } from './types.ts';

export type ActionRecipient = {
  recipient: string;
  state:
    | 'rejected'
    | 'reserved'
    | 'attempt_started'
    | 'provider_accepted'
    | 'failed'
    | 'outcome_unknown'
    | 'cancelled';
  errorCode: string | null;
  providerReference: string | null;
};
export type Admission = {
  operationId: string;
  replay: boolean;
  recipients: Array<ActionRecipient>;
  accountId?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function call<T>(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  path: string,
  body: unknown,
): Promise<T> {
  const raw = JSON.stringify(body);
  const response = await env.API.fetch(`https://api/internal/email/actions${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-void-internal': await sign(raw, env.JWT_SECRET),
    },
    body: raw,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    throw new Error(`EMAIL_ADMISSION_${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('EMAIL_ADMISSION_EMPTY_RESPONSE');
  }
  const bytes = new Uint8Array(65_536);
  let size = 0;
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('EMAIL_ADMISSION_TIMEOUT');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('EMAIL_ADMISSION_TIMEOUT')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > bytes.length) {
        throw new Error('EMAIL_ADMISSION_RESPONSE_TOO_LARGE');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    return JSON.parse(decoder.decode(bytes.subarray(0, size))) as T;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type RelayedReceiptIdentity = {
  receiptId: string;
  projectId: string;
  payloadDigest: string;
};

export function claimRelayedReceipt(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  identity: RelayedReceiptIdentity,
): Promise<{ state: 'claimed' | 'in_progress' | 'completed'; reject?: boolean }> {
  return call(env, '/receipts/claim', identity);
}

export function completeRelayedReceipt(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  identity: RelayedReceiptIdentity,
  reject: boolean,
): Promise<{ ok: true }> {
  return call(env, '/receipts/complete', { ...identity, reject });
}

/** Only generated, transport-irrelevant MIME fields are normalized. Body text stays byte-sensitive. */
export function canonicalizeVoidMime(raw: Uint8Array): Uint8Array {
  const mime = decoder.decode(raw);
  if (!mime.includes('\r\n\r\n')) {
    return raw;
  }
  const lines = mime.split('\r\n');
  const boundaries = new Map<string, string>();
  const output: Array<string> = [];
  let inHeaders = true;
  let topHeaders = true;
  for (const line of lines) {
    if (inHeaders) {
      if (line === '') {
        output.push(line);
        inHeaders = false;
        topHeaders = false;
        continue;
      }
      if (topHeaders && /^(?:Date|Message-ID): /i.test(line)) {
        continue;
      }
      if (/^Content-Type:\s*multipart\//i.test(line)) {
        output.push(
          line.replace(
            /boundary="(=_void_(?:mixed|alternative|related)_[A-Za-z0-9_-]+)"/g,
            (_, token: string) => {
              let marker = boundaries.get(token);
              if (!marker) {
                marker = `<void-boundary-${boundaries.size}>`;
                boundaries.set(token, marker);
              }
              return `boundary="${marker}"`;
            },
          ),
        );
        continue;
      }
      output.push(line);
      continue;
    }
    let delimiter = false;
    for (const [token, marker] of boundaries) {
      if (line === `--${token}`) {
        output.push(`--${marker}`);
        inHeaders = true;
        delimiter = true;
        break;
      }
      if (line === `--${token}--`) {
        output.push(`--${marker}--`);
        delimiter = true;
        break;
      }
    }
    if (!delimiter) {
      output.push(line);
    }
  }
  return encoder.encode(output.join('\r\n'));
}

export async function emailPayloadDigest(
  kind: string,
  from: string,
  recipients: Array<string>,
  raw: Uint8Array,
): Promise<string> {
  const canonical = canonicalizeVoidMime(raw);
  const prefix = encoder.encode(
    JSON.stringify({
      kind,
      from: from.toLowerCase(),
      recipients: [...new Set(recipients.map((r) => r.toLowerCase()))].sort(),
    }),
  );
  const input = new Uint8Array(prefix.length + 1 + canonical.length);
  input.set(prefix);
  input[prefix.length] = 0;
  input.set(canonical, prefix.length + 1);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function admitEmail(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  body: {
    projectId: string;
    kind: 'direct' | 'forward' | 'reply';
    key: string;
    digest: string;
    from: string;
    recipients: Array<string>;
    transport: 'binding' | 'send_raw' | 'native_forward' | 'native_reply';
    receiptId?: string;
  },
): Promise<Admission> {
  return call(env, '/admit', body);
}

export function startEmailAttempt(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  operationId: string,
  recipients: Array<string>,
): Promise<{ recipients: Array<ActionRecipient> }> {
  return call(env, `/${encodeURIComponent(operationId)}/start`, { recipients });
}

export function finishEmailAttempt(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  operationId: string,
  recipients: Array<string>,
  state: 'provider_accepted' | 'failed' | 'outcome_unknown' | 'cancelled',
  details: { providerReference?: string; errorCode?: string } = {},
): Promise<{ recipients: Array<ActionRecipient> }> {
  return call(env, `/${encodeURIComponent(operationId)}/finish`, { recipients, state, ...details });
}

export function recordEmailReceipt(
  env: Pick<Env, 'API' | 'JWT_SECRET'>,
  receiptId: string,
  projectId: string,
  status: string,
): Promise<{ ok: true }> {
  return call(env, '/receipts', { receiptId, projectId, status });
}
