import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CF_CUSTOMER_API_BASE,
  CF_EMAIL_OAUTH_CLIENT_ID,
  OAuthGrantError,
  createCfCustomerClient,
  refreshOauthGrant,
  revokeOauthGrant,
} from '../../src/email/cf-customer.ts';
import { CloudflareApiError } from '../../src/provisioning/cloudflare-api.ts';

// Dummy stand-ins — never real token material, per the no-secrets rule.
const CREDENTIAL = 'cf-credential-dummy';
const ACCOUNT = 'acct_1';
const ZONE = 'zone_1';
const RELAY = 'void-email-relay';

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string, status = 400): Response {
  return Response.json({ success: false, errors: [{ code: 100, message }] }, { status });
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1)!;
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit };
}

describe('cf-customer client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('verifyToken', () => {
    it('GETs /user/tokens/verify with the bearer and returns the result', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({ id: 'tok_1', status: 'active', expires_on: '2027-01-01T00:00:00Z' }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.verifyToken();

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/user/tokens/verify`);
      expect(init.method).toBeUndefined();
      expect(init.headers).toEqual({
        Authorization: `Bearer ${CREDENTIAL}`,
        'Content-Type': 'application/json',
      });
      expect(init.body).toBeUndefined();
      expect(result).toEqual({ id: 'tok_1', status: 'active', expires_on: '2027-01-01T00:00:00Z' });
    });

    it('throws CloudflareApiError carrying the HTTP status on envelope failure', async () => {
      fetchMock.mockResolvedValueOnce(cfError('invalid token', 401));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.verifyToken().catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(401);
      expect((error as CloudflareApiError).message).toContain('invalid token');
    });
  });

  describe('findZone', () => {
    it('GETs /zones?name= and returns the exact-name match with its account', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess([
          { id: 'zone_9', name: 'acme.com.evil.example', account: { id: 'acct_9' } },
          { id: ZONE, name: 'acme.com', account: { id: ACCOUNT } },
        ]),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const zone = await client.findZone('acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones?name=acme.com`);
      expect(init.method).toBeUndefined();
      expect(zone).toEqual({ id: ZONE, name: 'acme.com', account: { id: ACCOUNT } });
    });

    it('returns null when the credential sees no such zone', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess([]));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.findZone('acme.com')).resolves.toBeNull();
    });
  });

  describe('enableRouting', () => {
    it('POSTs an empty body for the apex', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.enableRouting(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/dns`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
    });

    it('POSTs { name } for a subdomain', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.enableRouting(ZONE, 'mail.acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/dns`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'mail.acme.com' });
    });
  });

  describe('onboardSending', () => {
    it('POSTs /zones/{z}/email/sending/subdomains with { name }', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.onboardSending(ZONE, 'mail.acme.com');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ name: 'mail.acme.com' });
    });
  });

  describe('listSendingSubdomains', () => {
    it('GETs the list and parses name + enabled, dropping malformed entries', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess([
          { name: 'mail.acme.com', enabled: true, tag: 'sub_1' },
          { name: 'alerts.acme.com' }, // enabled missing → false
          'not-an-object',
          { enabled: true }, // no name → dropped
        ]),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.listSendingSubdomains(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=1&per_page=50`,
      );
      expect(init.method).toBeUndefined();
      // A short page (<50 rows) is the last page — exactly one request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { name: 'mail.acme.com', enabled: true },
        { name: 'alerts.acme.com', enabled: false },
      ]);
    });

    it('paginates: a full page is followed by the next until a short page', async () => {
      const pageOne = Array.from({ length: 50 }, (_, index) => ({
        name: `sub-${String(index + 1).padStart(2, '0')}.acme.com`,
        enabled: index % 2 === 0,
      }));
      fetchMock.mockResolvedValueOnce(cfSuccess(pageOne));
      fetchMock.mockResolvedValueOnce(cfSuccess([{ name: 'mail.acme.com', enabled: true }]));
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.listSendingSubdomains(ZONE);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=1&per_page=50`,
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        `${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/sending/subdomains?page=2&per_page=50`,
      );
      expect(result).toHaveLength(51);
      expect(result[0]).toEqual({ name: 'sub-01.acme.com', enabled: true });
      expect(result.at(-1)).toEqual({ name: 'mail.acme.com', enabled: true });
    });

    it('returns [] when the result is not an array', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.listSendingSubdomains(ZONE)).resolves.toEqual([]);
    });
  });

  describe('putRelayScript', () => {
    it('PUTs multipart FormData with metadata (main_module, compat date, plain-text vars) and the module', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({ id: 'script_1' }));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.putRelayScript(ACCOUNT, RELAY, {
        source: 'export default {};\n',
        compatibilityDate: '2026-09-01',
        proxyOrigin: 'https://proxy.example.test',
        emailDomain: 'acme.com',
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBe('PUT');
      // The multipart boundary belongs to fetch — the client must not pin a
      // Content-Type on a FormData body.
      expect(init.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });

      const formData = init.body as FormData;
      expect(formData).toBeInstanceOf(FormData);
      const metadataPart = formData.get('metadata') as File;
      const metadata = JSON.parse(await metadataPart.text());
      expect(metadata).toEqual({
        main_module: 'index.js',
        compatibility_date: '2026-09-01',
        bindings: [
          {
            type: 'plain_text',
            name: 'VOID_PROXY_ORIGIN',
            text: 'https://proxy.example.test',
          },
          { type: 'plain_text', name: 'VOID_EMAIL_DOMAIN', text: 'acme.com' },
        ],
      });
      const modulePart = formData.get('index.js') as File;
      expect(modulePart.name).toBe('index.js');
      expect(await modulePart.text()).toBe('export default {};\n');
    });
  });

  describe('putRelaySecret', () => {
    it('PUTs { name: VOID_RELAY_SECRET, text, type: secret_text } to .../secrets', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.putRelaySecret(ACCOUNT, RELAY, 'relay-secret-dummy');

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(
        `${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}/secrets`,
      );
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'VOID_RELAY_SECRET',
        text: 'relay-secret-dummy',
        type: 'secret_text',
      });
    });
  });

  describe('catch-all rules', () => {
    it('setCatchAll PUTs the all-matcher + one worker action naming the relay, enabled', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.setCatchAll(ZONE, RELAY);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        matchers: [{ type: 'all' }],
        actions: [{ type: 'worker', value: [RELAY] }],
        enabled: true,
      });
    });

    it("resetCatchAll PUTs wrangler's reset shape: one drop action, disabled", async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.resetCatchAll(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({
        matchers: [{ type: 'all' }],
        actions: [{ type: 'drop' }],
        enabled: false,
      });
    });
  });

  describe('getCatchAll', () => {
    it('returns the enabled flag and the worker target of the first action', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'worker', value: [RELAY] }],
        }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.getCatchAll(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing/rules/catch_all`);
      expect(init.method).toBeUndefined();
      expect(result).toEqual({ enabled: true, workerName: RELAY });
    });

    it('returns workerName null for a non-worker action shape', async () => {
      fetchMock.mockResolvedValueOnce(
        cfSuccess({
          enabled: true,
          matchers: [{ type: 'all' }],
          actions: [{ type: 'forward', value: ['dest@example.net'] }],
        }),
      );
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.getCatchAll(ZONE)).resolves.toEqual({
        enabled: true,
        workerName: null,
      });
    });

    it('maps a 404 to null (no rule configured)', async () => {
      fetchMock.mockResolvedValueOnce(cfError('rule not found', 404));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.getCatchAll(ZONE)).resolves.toBeNull();
    });

    it('rethrows a non-404 failure', async () => {
      fetchMock.mockResolvedValueOnce(cfError('forbidden', 403));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.getCatchAll(ZONE).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(403);
    });
  });

  describe('getRoutingSettings', () => {
    it('GETs /zones/{z}/email/routing and returns the raw result', async () => {
      const settings = { id: ZONE, name: 'acme.com', enabled: true, status: 'ready' };
      fetchMock.mockResolvedValueOnce(cfSuccess(settings));
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.getRoutingSettings(ZONE);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/zones/${ZONE}/email/routing`);
      expect(init.method).toBeUndefined();
      expect(result).toEqual(settings);
    });
  });

  describe('relayScriptExists', () => {
    it('is false on 404 and true on 200, without parsing an envelope', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
      fetchMock.mockResolvedValueOnce(new Response('export default {};', { status: 200 }));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.relayScriptExists(ACCOUNT, RELAY)).resolves.toBe(false);
      await expect(client.relayScriptExists(ACCOUNT, RELAY)).resolves.toBe(true);

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBeUndefined();
      expect(init.headers).toEqual({ Authorization: `Bearer ${CREDENTIAL}` });
    });

    it('throws CloudflareApiError on other statuses', async () => {
      fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
      const client = createCfCustomerClient(CREDENTIAL);

      const error = await client.relayScriptExists(ACCOUNT, RELAY).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CloudflareApiError);
      expect((error as CloudflareApiError).status).toBe(403);
    });
  });

  describe('deleteRelayScript', () => {
    it('DELETEs the script and tolerates a 404 (customer deleted it first)', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({}));
      fetchMock.mockResolvedValueOnce(cfError('not found', 404));
      const client = createCfCustomerClient(CREDENTIAL);

      await client.deleteRelayScript(ACCOUNT, RELAY);
      await client.deleteRelayScript(ACCOUNT, RELAY);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/workers/scripts/${RELAY}`);
      expect(init.method).toBe('DELETE');
    });

    it('throws on other envelope failures', async () => {
      fetchMock.mockResolvedValueOnce(cfError('boom', 500));
      const client = createCfCustomerClient(CREDENTIAL);

      await expect(client.deleteRelayScript(ACCOUNT, RELAY)).rejects.toThrow('boom');
    });
  });

  describe('sendRaw', () => {
    it('POSTs { from, recipients, mime_message } to the account send_raw endpoint', async () => {
      fetchMock.mockResolvedValueOnce(cfSuccess({ message_id: 'msg_1' }));
      const client = createCfCustomerClient(CREDENTIAL);

      const result = await client.sendRaw(ACCOUNT, {
        from: 'noreply@acme.com',
        recipients: ['user@example.org'],
        mime_message: 'MIME-DUMMY',
      });

      const { url, init } = lastCall(fetchMock);
      expect(url).toBe(`${CF_CUSTOMER_API_BASE}/accounts/${ACCOUNT}/email/sending/send_raw`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        from: 'noreply@acme.com',
        recipients: ['user@example.org'],
        mime_message: 'MIME-DUMMY',
      });
      expect(result).toEqual({ message_id: 'msg_1' });
    });
  });
});

describe('refreshOauthGrant', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the form-encoded refresh grant to wrangler's client", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        access_token: 'cf-access-dummy',
        refresh_token: 'cf-rotated-dummy',
        expires_in: 3600,
      }),
    );

    const tokens = await refreshOauthGrant('cf-refresh-dummy');

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://dash.cloudflare.com/oauth2/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const params = new URLSearchParams(init.body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('client_id')).toBe(CF_EMAIL_OAUTH_CLIENT_ID);
    expect(params.get('refresh_token')).toBe('cf-refresh-dummy');
    expect(tokens).toEqual({
      accessToken: 'cf-access-dummy',
      refreshToken: 'cf-rotated-dummy',
      expiresIn: 3600,
    });
  });

  it('throws OAuthGrantError with the upstream code, never token material', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: 'invalid_grant', error_description: 'refresh token unknown' },
        { status: 400 },
      ),
    );

    const error = await refreshOauthGrant('cf-refresh-dummy').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OAuthGrantError);
    expect((error as OAuthGrantError).code).toBe('invalid_grant');
    expect((error as OAuthGrantError).status).toBe(400);
    expect((error as OAuthGrantError).message).not.toContain('cf-refresh-dummy');
  });

  it('fails loudly when the answer carries no rotated refresh token', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'cf-access-dummy' }));

    const error = await refreshOauthGrant('cf-refresh-dummy').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OAuthGrantError);
    expect((error as OAuthGrantError).code).toBe('invalid_response');
  });

  it('classifies a non-JSON error body as unknown_error with the HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }));

    const error = await refreshOauthGrant('cf-refresh-dummy').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OAuthGrantError);
    expect((error as OAuthGrantError).code).toBe('unknown_error');
    expect((error as OAuthGrantError).status).toBe(502);
  });
});

describe('revokeOauthGrant', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // console.error output must never carry the token — render every logged
  // argument (Errors included) before searching for it.
  function loggedText(errorSpy: { mock: { calls: Array<Array<unknown>> } }): string {
    return errorSpy.mock.calls
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
      .join(' ');
  }

  it("POSTs the form-encoded revocation to wrangler's client, with no Authorization header", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(revokeOauthGrant('cf-refresh-dummy')).resolves.toBeUndefined();

    const { url, init } = lastCall(fetchMock);
    expect(url).toBe('https://dash.cloudflare.com/oauth2/revoke');
    expect(init.method).toBe('POST');
    // A public client authenticates with the token itself — no bearer.
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const params = new URLSearchParams(init.body as string);
    expect(params.get('client_id')).toBe(CF_EMAIL_OAUTH_CLIENT_ID);
    expect(params.get('token_type_hint')).toBe('refresh_token');
    expect(params.get('token')).toBe('cf-refresh-dummy');
    // A 2xx is silent (RFC 7009: revoked-or-invalid both answer 200).
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx, logging an error that never carries the token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of [400, 500]) {
      fetchMock.mockResolvedValueOnce(new Response('boom', { status }));
      await expect(revokeOauthGrant('cf-refresh-dummy')).rejects.toThrow(`HTTP ${status}`);
    }

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const logged = loggedText(errorSpy);
    expect(logged).toContain('400');
    expect(logged).toContain('500');
    expect(logged).not.toContain('cf-refresh-dummy');
  });

  it('rethrows a network rejection, logging an error that never carries the token', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(revokeOauthGrant('cf-refresh-dummy')).rejects.toThrow('fetch failed');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(loggedText(errorSpy)).not.toContain('cf-refresh-dummy');
  });
});
