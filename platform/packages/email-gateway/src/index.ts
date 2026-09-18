import { claimRelayedReceipt, completeRelayedReceipt } from '../../proxy/src/email-admission.ts';
import {
  routeInbound,
  routeRelayed,
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
} from '../../proxy/src/email-router.ts';
import type { EmailEnvelope } from '../../proxy/src/email-router.ts';
import type { Env as ProxyEnv } from '../../proxy/src/types.ts';

type Env = ProxyEnv & {
  PLATFORM_INSTALLATION_ID?: string;
  PLATFORM_TRAFFIC_STATE?: string;
  EMAIL_SHARED_ACCOUNT_ID?: string;
  EMAIL_SHARED_ZONE_ID?: string;
  EMAIL_SHARED_INGRESS_NAME?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_HEADER_BYTES = 128 * 1024;
const MAX_ENVELOPE_HEADER = 320;
const MAX_CONCURRENT_DELIVERIES = 2;
let activeDeliveries = 0;

async function withDeliverySlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeDeliveries >= MAX_CONCURRENT_DELIVERIES) {
    throw new Error('email gateway busy');
  }
  activeDeliveries++;
  try {
    return await run();
  } finally {
    activeDeliveries--;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  for (const byte of signature) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

type Route = {
  connectionId: string;
  projectId: string;
  workerName: string;
  deploymentId: string;
  slug: string;
  domain: string;
  addressing: 'shared' | 'custom';
  limits?: Record<string, number>;
};

async function resolveIngress(
  env: Env,
  input: {
    accountId: string;
    zoneId: string;
    ingressName: string;
    from: string;
    to: string;
    secret?: string;
    native?: true;
  },
): Promise<Route | null> {
  const proof = await sign(
    `email-ingress-v1\n${input.accountId}\n${input.zoneId}\n${input.ingressName}\n${input.to.toLowerCase()}`,
    env.JWT_SECRET,
  );
  const response = await env.API.fetch('https://api/internal/email/resolve-ingress', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-void-internal': proof },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw new Error('email routing unavailable');
    }
    return null;
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    throw new Error('invalid email routing response');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('invalid email routing response');
  }
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const deadline = Date.now() + 5_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('email routing response timeout');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ingress resolution timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > 4096) {
        throw new Error('invalid email routing response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = decoder.decode(bytes);
  let route: unknown;
  try {
    route = JSON.parse(text);
  } catch {
    throw new Error('invalid email routing response');
  }
  if (!route || typeof route !== 'object') {
    throw new Error('invalid email routing response');
  }
  const value = route as Partial<Route>;
  if (
    typeof value.projectId !== 'string' ||
    typeof value.connectionId !== 'string' ||
    typeof value.workerName !== 'string' ||
    typeof value.deploymentId !== 'string' ||
    typeof value.slug !== 'string' ||
    typeof value.domain !== 'string' ||
    (value.addressing !== 'shared' && value.addressing !== 'custom')
  ) {
    throw new Error('invalid email routing response');
  }
  return value as Route;
}

async function readMime(
  stream: ReadableStream<Uint8Array> | null,
  declared: number,
): Promise<Uint8Array> {
  if (!stream || !Number.isSafeInteger(declared) || declared < 0 || declared > MAX_INBOUND_BYTES) {
    throw new Error('invalid MIME length');
  }
  const reader = stream.getReader();
  const result = new Uint8Array(declared);
  let size = 0;
  const deadline = Date.now() + 15_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('MIME timeout');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('MIME timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > declared || size > MAX_INBOUND_BYTES) {
        throw new Error('MIME too large');
      }
      result.set(chunk.value, size - chunk.value.byteLength);
    }
    if (size !== declared) {
      throw new Error('truncated MIME');
    }
    return result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseHeaders(raw: Uint8Array): Record<string, string> {
  let end = -1;
  for (let i = 0; i < raw.length - 3 && i < MAX_HEADER_BYTES + 4; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0 || end > MAX_HEADER_BYTES) {
    throw new Error('invalid MIME headers');
  }
  const lines = decoder.decode(raw.subarray(0, end)).split('\r\n');
  const headers: Record<string, string> = Object.create(null);
  let current = '';
  let physicalLines = 0;
  for (const line of lines) {
    if (++physicalLines > MAX_INBOUND_HEADERS) {
      throw new Error('too many MIME headers');
    }
    if (/^[ \t]/.test(line)) {
      if (!current) {
        throw new Error('invalid MIME header fold');
      }
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new Error('invalid MIME header');
    }
    const name = line.slice(0, colon).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new Error('invalid MIME header name');
    }
    headers[name] = headers[name]
      ? `${headers[name]}, ${line.slice(colon + 1).trim()}`
      : line.slice(colon + 1).trim();
    current = name;
  }
  return headers;
}

async function ingress(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.PLATFORM_TRAFFIC_STATE === 'staging' || env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain') {
    return new Response(null, { status: 503 });
  }
  if (request.headers.get('content-encoding')) {
    return new Response(null, { status: 415 });
  }
  const accountId = request.headers.get('x-void-email-account') ?? '';
  const zoneId = request.headers.get('x-void-email-zone') ?? '';
  const ingressName = request.headers.get('x-void-email-ingress') ?? '';
  const requestId = request.headers.get('x-void-email-request-id') ?? '';
  const from = request.headers.get('x-void-email-from') ?? '';
  const to = request.headers.get('x-void-email-to') ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  if (
    [accountId, zoneId, ingressName, from, to, authorization].some(
      (value) => !value || value.length > MAX_ENVELOPE_HEADER,
    ) ||
    !authorization.startsWith('Bearer ') ||
    !/^[a-f0-9-]{36}$/.test(requestId)
  ) {
    return new Response(null, { status: 400 });
  }
  const declaredHeader = request.headers.get('content-length');
  if (declaredHeader === null || !/^\d+$/.test(declaredHeader)) {
    return new Response(null, { status: 411 });
  }
  const declared = Number(declaredHeader);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    return new Response(null, { status: 411 });
  }
  if (declared > MAX_INBOUND_BYTES) {
    return new Response(null, { status: 413 });
  }
  let route: Route | null;
  try {
    route = await resolveIngress(env, {
      accountId,
      zoneId,
      ingressName,
      from,
      to,
      secret: authorization.slice(7),
    });
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!route) {
    return new Response(null, { status: 403 });
  }
  try {
    const raw = await readMime(request.body, declared);
    const headers = parseHeaders(raw);
    const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();
    if (domain !== route.domain) {
      return new Response(null, { status: 403 });
    }
    const envelope: EmailEnvelope = {
      from,
      to,
      raw,
      rawSize: raw.byteLength,
      headers,
      ...(route.addressing === 'custom' ? { viaDomain: domain } : {}),
    };
    const receiptId = await sha256(encoder.encode(JSON.stringify([route.connectionId, requestId])));
    const payloadDigest = await sha256(
      encoder.encode(JSON.stringify([from, to, await sha256(raw)])),
    );
    const identity = { receiptId, projectId: route.projectId, payloadDigest };
    let claim;
    try {
      claim = await claimRelayedReceipt(env, identity);
    } catch (error) {
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
        return new Response(null, { status: 409 });
      }
      throw error;
    }
    if (claim.state === 'completed' && typeof claim.reject === 'boolean') {
      return new Response(null, {
        status: claim.reject ? 403 : 204,
        headers: { 'x-void-email-receipt': receiptId },
      });
    }
    if (claim.state !== 'claimed') {
      return new Response(null, { status: 503, headers: { 'x-void-email-receipt': receiptId } });
    }
    const result = await routeRelayed(env, ctx, {
      projectId: route.projectId,
      domain,
      envelope,
      authoritative: route,
      receiptId,
    });
    if (result.temporary) {
      return new Response(null, { status: 503 });
    }
    try {
      await completeRelayedReceipt(env, identity, result.reject);
    } catch {
      // The receipt remains unresolved. Never rerun completed tenant work or
      // already-submitted actions just because its final checkpoint was lost.
      console.error('[email-gateway] receipt completion remains unresolved', receiptId);
    }
    return new Response(null, {
      status: result.reject ? 403 : 204,
      headers: { 'x-void-email-receipt': receiptId },
    });
  } catch (error) {
    console.error(
      '[email-gateway] ingress failed:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
    return new Response(null, { status: 502 });
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function probe(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('content-encoding')) {
    return new Response(null, { status: 400 });
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024)) {
    return new Response(null, { status: 400 });
  }
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length > MAX_ENVELOPE_HEADER) {
    return new Response(null, { status: 403 });
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return new Response(null, { status: 400 });
  }
  const bytes = new Uint8Array(1024);
  let size = 0;
  const deadline = Date.now() + 5_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return new Response(null, { status: 400 });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > bytes.byteLength) {
        return new Response(null, { status: 400 });
      }
      bytes.set(chunk.value, size - chunk.value.byteLength);
    }
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0 || (declared && size !== Number(declared))) {
    return new Response(null, { status: 400 });
  }
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(bytes.subarray(0, size)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!input || typeof input !== 'object') {
    return new Response(null, { status: 400 });
  }
  const { accountId, zoneId, ingressName } = input as Record<string, unknown>;
  if (
    [accountId, zoneId, ingressName].some(
      (value) => typeof value !== 'string' || !value || value.length > MAX_ENVELOPE_HEADER,
    )
  ) {
    return new Response(null, { status: 400 });
  }
  const proof = await sign(
    `email-probe-v1\n${accountId}\n${zoneId}\n${ingressName}`,
    env.JWT_SECRET,
  );
  try {
    const response = await env.API.fetch('https://api/internal/email/probe-ingress', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-void-internal': proof },
      body: JSON.stringify({ accountId, zoneId, ingressName, secret: authorization.slice(7) }),
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(null, { status: response.status === 204 ? 204 : 403 });
  } catch {
    return new Response(null, { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === '/email/probe') {
      return probe(request, env);
    }
    if (url.pathname === '/email/ingress') {
      try {
        return await withDeliverySlot(() => ingress(request, env, ctx));
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    return new Response(null, { status: 404 });
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const accountId = env.EMAIL_SHARED_ACCOUNT_ID;
    const zoneId = env.EMAIL_SHARED_ZONE_ID;
    const ingressName = env.EMAIL_SHARED_INGRESS_NAME;
    if (!accountId || !zoneId || !ingressName) {
      message.setReject('Email routing is not configured');
      return;
    }
    let route: Route | null;
    try {
      route = await resolveIngress(env, {
        accountId,
        zoneId,
        ingressName,
        from: message.from,
        to: message.to,
        native: true,
      });
    } catch {
      throw new Error('Email route temporarily unavailable');
    }
    if (!route) {
      message.setReject('Email route unavailable');
      return;
    }
    await withDeliverySlot(() => routeInbound(message, env, ctx, route));
  },
};
