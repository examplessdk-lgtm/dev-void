import { describe, expect, it, vi } from 'vite-plus/test';
import { githubWebhookIngressFetch } from '../../src/github-webhook-ingress.ts';
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  verifyGitHubWebhookIngressProof,
} from '../../src/github/webhook-ingress-auth.ts';

const webhookSecret = 'github-webhook-secret';
const ingressSecret = 'purpose-separated-ingress-secret-with-32-bytes';
const deliveryId = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

async function githubSignature(body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, body.slice().buffer);
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256=${hex}`;
}

async function request(
  body: string,
  headers: Record<string, string> = {},
  url = 'https://hooks.example.com/github',
  method = 'POST',
): Promise<Request> {
  const bytes = new TextEncoder().encode(body);
  return new Request(url.startsWith('/') ? `https://hooks.example.com${url}` : url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': deliveryId,
      'X-Hub-Signature-256': await githubSignature(bytes),
      ...headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

function env(fetch: (request: Request) => Promise<Response>) {
  return {
    API: { fetch } as Fetcher,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_WEBHOOK_INGRESS_SECRET: ingressSecret,
  };
}

describe('GitHub webhook ingress Worker', () => {
  it('exposes only the exact POST /github operation', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    expect(
      (await githubWebhookIngressFetch(await request('{}', {}, '/other'), env(fetch))).status,
    ).toBe(404);
    expect(
      (await githubWebhookIngressFetch(await request('{}', {}, '/github?next=/admin'), env(fetch)))
        .status,
    ).toBe(404);
    expect(
      (await githubWebhookIngressFetch(await request('{}', {}, '/github', 'GET'), env(fetch)))
        .status,
    ).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid GitHub signature before the service binding', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const response = await githubWebhookIngressFetch(
      await request('{}', { 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }),
      env(fetch),
    );
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing, oversized, or non-JSON delivery headers', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    expect(
      (
        await githubWebhookIngressFetch(
          await request('{}', { 'X-GitHub-Delivery': 'x'.repeat(129) }),
          env(fetch),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await githubWebhookIngressFetch(
          await request('{}', { 'X-GitHub-Event': `p${'u'.repeat(64)}` }),
          env(fetch),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await githubWebhookIngressFetch(
          await request('{}', { 'Content-Type': 'application/x-www-form-urlencoded' }),
          env(fetch),
        )
      ).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized or inconsistent bodies even when Content-Length lies', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const tooLarge = await githubWebhookIngressFetch(
      await request('{}', { 'Content-Length': String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1) }),
      env(fetch),
    );
    expect(tooLarge.status).toBe(413);
    const inconsistent = await githubWebhookIngressFetch(
      await request('{}', { 'Content-Length': '1' }),
      env(fetch),
    );
    expect(inconsistent.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards a fixed operation with a valid proof and strips caller credentials', async () => {
    let forwarded: Request | undefined;
    const fetch = vi.fn(async (request: Request) => {
      forwarded = request;
      return Response.json({ ok: true }, { headers: { 'X-Internal-Only': 'hidden' } });
    });
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const response = await githubWebhookIngressFetch(
      await request(body, {
        Authorization: 'Bearer attacker',
        Cookie: 'session=attacker',
        'Cf-Access-Jwt-Assertion': 'attacker-access',
        'X-Void-GitHub-Ingress-Proof': 'attacker-proof',
      }),
      env(fetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Internal-Only')).toBeNull();
    expect(forwarded?.url).toBe('https://void-api.internal/internal/github-webhook');
    expect(forwarded?.method).toBe('POST');
    expect(forwarded?.headers.get('Authorization')).toBeNull();
    expect(forwarded?.headers.get('Cookie')).toBeNull();
    expect(forwarded?.headers.get('Cf-Access-Jwt-Assertion')).toBeNull();
    const forwardedBody = new Uint8Array(await forwarded!.clone().arrayBuffer());
    expect(new TextDecoder().decode(forwardedBody)).toBe(body);
    expect(
      await verifyGitHubWebhookIngressProof({
        secret: ingressSecret,
        timestampHeader: forwarded!.headers.get('X-Void-GitHub-Ingress-Timestamp'),
        proofHeader: forwarded!.headers.get('X-Void-GitHub-Ingress-Proof'),
        deliveryId,
        event: 'push',
        body: forwardedBody,
      }),
    ).toBe(true);
  });
});
