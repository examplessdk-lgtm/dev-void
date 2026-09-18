/**
 * The relay worker — the one worker the platform deploys into the
 * CUSTOMER's Cloudflare account, one per connected zone. An Email Routing
 * catch-all can only name a Worker in its own account, so this Worker streams
 * the raw MIME and SMTP envelope into the installation email gateway's
 * POST /email/ingress, authenticated by the zone connection secret.
 *
 * The source is embedded as a string because the api deploys it at runtime
 * into an account it does not own — it is never bundled into the api
 * worker itself.
 *
 * `void email domain sync` redeploys at the current RELAY_VERSION. Secret
 * rotation is a separate durable operation proven against the deployed
 * Worker before promotion. The Worker name stays stable for its zone.
 */

export const RELAY_VERSION = 6;

// Baked into the upload metadata; bump with RELAY_VERSION if the source
// ever depends on newer runtime behavior.
export const RELAY_COMPATIBILITY_DATE = '2026-09-01';

// The binding names the upload declares (plain-text vars + one secret) and
// the source reads. Pinned to RELAY_SOURCE by the unit tests — the two
// must move together or the deployed relay reads undefined bindings.
export const RELAY_SECRET_BINDING = 'VOID_RELAY_SECRET';
export const RELAY_GATEWAY_ORIGIN_BINDING = 'VOID_EMAIL_GATEWAY_ORIGIN';
export const RELAY_ACCOUNT_BINDING = 'VOID_EMAIL_ACCOUNT';
export const RELAY_ZONE_BINDING = 'VOID_EMAIL_ZONE';
export const RELAY_INGRESS_BINDING = 'VOID_EMAIL_INGRESS';

/**
 * Module-syntax Worker source. POST /email/ingress on the configured gateway
 * with zone identity, envelope sender/recipient and the unparsed MIME.
 * The stream is piped through a FixedLengthStream(rawSize):
 * the runtime derives Content-Length from the body and IGNORES a manually
 * set one, so a plain ReadableStream would go out chunked — and the gateway
 * rejects a length-less body before any crypto. The POST rides
 * ctx.waitUntil AND is awaited: waitUntil keeps the stream alive, the
 * await is what lets a non-2xx answer reject the message. The reject
 * reason is deliberately generic — it travels back to the original sender
 * in a bounce.
 *
 * The gateway resolves the exact envelope recipient domain against the
 * authoritative connection route map. This relay therefore forwards every
 * recipient on its zone, including sibling domains.
 */
export const RELAY_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/__void/email/probe') return new Response(null, { status: 404 });
    const challenge = request.headers.get('X-Void-Probe-Challenge') ?? '';
    const generation = request.headers.get('X-Void-Probe-Generation') ?? '';
    if (!/^[a-f0-9]{64}$/.test(challenge) || !/^[1-9][0-9]{0,9}$/.test(generation)) return new Response(null, { status: 400 });
    const payload = ['email-relay-proof-v1', env.VOID_EMAIL_ACCOUNT, env.VOID_EMAIL_ZONE, env.VOID_EMAIL_INGRESS, generation, challenge].join('\\n');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.VOID_RELAY_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    const proof = Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('');
    return Response.json({ accountId: env.VOID_EMAIL_ACCOUNT, zoneId: env.VOID_EMAIL_ZONE, ingressName: env.VOID_EMAIL_INGRESS, generation: Number(generation), challenge, proof }, { headers: { 'Cache-Control': 'no-store' } });
  },
  async email(message, env, ctx) {
    const requestId = crypto.randomUUID();
    const { readable, writable } = new FixedLengthStream(message.rawSize);
    const relay = fetch(env.VOID_EMAIL_GATEWAY_ORIGIN + '/email/ingress', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.VOID_RELAY_SECRET,
        'X-Void-Email-Account': env.VOID_EMAIL_ACCOUNT,
        'X-Void-Email-Zone': env.VOID_EMAIL_ZONE,
        'X-Void-Email-Ingress': env.VOID_EMAIL_INGRESS,
        'X-Void-Email-Request-Id': requestId,
        'X-Void-Email-From': message.from,
        'X-Void-Email-To': message.to,
      },
      body: readable,
    });
    ctx.waitUntil(message.raw.pipeTo(writable));
    ctx.waitUntil(relay);
    const response = await relay;
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new Error('Email gateway temporarily unavailable');
    }
    if (!response.ok) {
      message.setReject('Unable to deliver message');
    }
  },
};
`;
