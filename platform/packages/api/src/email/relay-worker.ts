/**
 * The relay worker — the one worker the platform deploys into the
 * CUSTOMER's Cloudflare account, one per registered email domain (design
 * doc 0078, "The two paths"). A routing rule can only name a worker in its
 * own account, so inbound from a customer zone cannot reach the proxy
 * directly; this ~30-line worker is the cross-account hop. It streams the
 * raw MIME, unparsed and unbuffered, into the proxy's POST /email/relay
 * with the domain's relay secret as the bearer.
 *
 * The source is embedded as a string because the api deploys it at runtime
 * into an account it does not own — it is never bundled into the api
 * worker itself.
 *
 * `void email domain sync` redeploys at the current RELAY_VERSION and
 * rotates the secret. The deployed worker NAME is stable forever: renaming
 * a worker detaches every routing rule that points at it.
 */

export const RELAY_VERSION = 2;

// Baked into the upload metadata; bump with RELAY_VERSION if the source
// ever depends on newer runtime behavior.
export const RELAY_COMPATIBILITY_DATE = '2026-09-01';

// The binding names the upload declares (plain-text vars + one secret) and
// the source reads. Pinned to RELAY_SOURCE by the unit tests — the two
// must move together or the deployed relay reads undefined bindings.
export const RELAY_SECRET_BINDING = 'VOID_RELAY_SECRET';
export const RELAY_PROXY_ORIGIN_BINDING = 'VOID_PROXY_ORIGIN';
export const RELAY_EMAIL_DOMAIN_BINDING = 'VOID_EMAIL_DOMAIN';

/**
 * Module-syntax worker source. Wire contract with the proxy (design doc
 * 0078, contract 3): POST {VOID_PROXY_ORIGIN}/email/relay, bearer =
 * VOID_RELAY_SECRET, X-Void-Email-* headers carrying the domain and the
 * envelope sender/recipient, body = the raw MIME streamed straight from
 * message.raw. Content-Length comes from message.rawSize because the proxy
 * rejects a length-less body before any crypto, and a streamed body would
 * otherwise go out chunked. The POST rides ctx.waitUntil AND is awaited:
 * waitUntil keeps the stream alive, the await is what lets a non-2xx
 * answer reject the message. The reject reason is deliberately generic —
 * it travels back to the original sender in a bounce.
 *
 * The recipient-domain guard is the relay-side half of the proxy's
 * recipient-domain attribution rule: a catch-all rule can be zone-wide,
 * so mail addressed to a DIFFERENT domain on the same zone can land here.
 * That mail is not this relay's to forward — the proxy would (correctly)
 * refuse it against this domain's secret — so it is refused here, loudly,
 * rather than dropped. RELAY_VERSION 2.
 */
export const RELAY_SOURCE = `export default {
  async email(message, env, ctx) {
    const recipientDomain = message.to.slice(message.to.lastIndexOf('@') + 1).toLowerCase();
    if (recipientDomain !== env.VOID_EMAIL_DOMAIN) {
      message.setReject('Unable to deliver message');
      return;
    }
    const relay = fetch(env.VOID_PROXY_ORIGIN + '/email/relay', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.VOID_RELAY_SECRET,
        'X-Void-Email-Domain': env.VOID_EMAIL_DOMAIN,
        'X-Void-Email-From': message.from,
        'X-Void-Email-To': message.to,
        'Content-Length': String(message.rawSize),
      },
      body: message.raw,
    });
    ctx.waitUntil(relay);
    const response = await relay;
    if (!response.ok) {
      message.setReject('Unable to deliver message');
    }
  },
};
`;
