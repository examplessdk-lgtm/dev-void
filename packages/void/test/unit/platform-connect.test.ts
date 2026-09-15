import { afterEach, describe, expect, it } from 'vite-plus/test';
import { discoverPlatform } from '../../src/cli/platform-cmd.ts';

const document = {
  apiUrl: 'https://api.example.com',
  applicationDomain: 'apps.example.com',
  authenticationProviders: ['github'],
  capabilities: {
    ai: true,
    customDomains: false,
    email: false,
    githubActions: false,
    githubOAuth: true,
    googleOAuth: false,
    managedBuilds: false,
    sandbox: false,
  },
  displayName: 'Example',
  installationId: 'example-a1b2c3d4',
  platformVersion: '1.0.0',
  proxyUrl: 'https://proxy.example.com',
  schemaVersion: 1,
};

afterEach(() => {
  delete process.env.CF_ACCESS_CLIENT_ID;
  delete process.env.CF_ACCESS_CLIENT_SECRET;
  delete process.env.CF_ACCESS_TOKEN;
});

describe('platform discovery', () => {
  it('accepts a valid document from its declared origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });
    await expect(
      discoverPlatform('https://api.example.com', async () => response),
    ).resolves.toMatchObject({ displayName: 'Example' });
  });

  it('fills the hosted proxy for older Void Cloud discovery documents', async () => {
    const legacyHosted = { ...document, apiUrl: 'https://api.void.cloud' } as Record<
      string,
      unknown
    >;
    delete legacyHosted.proxyUrl;
    const response = new Response(JSON.stringify(legacyHosted));
    Object.defineProperty(response, 'url', {
      value: 'https://api.void.cloud/.well-known/void-platform',
    });

    await expect(
      discoverPlatform('https://api.void.cloud', async () => response),
    ).resolves.toMatchObject({ proxyUrl: 'https://proxy.void.cloud' });
  });

  it('rejects custom discovery documents without a proxy origin', async () => {
    const incomplete = { ...document } as Record<string, unknown>;
    delete incomplete.proxyUrl;
    const response = new Response(JSON.stringify(incomplete));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });

    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'proxyUrl',
    );
  });

  it('rejects discovery documents that claim a different origin', async () => {
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://evil.example/.well-known/void-platform',
    });
    await expect(discoverPlatform('https://api.example.com', async () => response)).rejects.toThrow(
      'origin mismatch',
    );
  });

  it('authenticates discovery for Access-gated Void Cloud staging', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'client-secret';
    const stagingDocument = {
      ...document,
      apiUrl: 'https://api.staging.void.cloud',
      proxyUrl: 'https://proxy.staging.void.cloud',
    };
    const response = new Response(JSON.stringify(stagingDocument));
    Object.defineProperty(response, 'url', {
      value: 'https://api.staging.void.cloud/.well-known/void-platform',
    });
    let request: RequestInit | undefined;

    await discoverPlatform('https://api.staging.void.cloud', async (_input, init) => {
      request = init;
      return response;
    });

    expect(request?.headers).toMatchObject({
      'CF-Access-Client-Id': 'client-id',
      'CF-Access-Client-Secret': 'client-secret',
    });
    expect(request?.redirect).toBe('manual');
  });

  it('does not forward hosted Access credentials to a user platform origin', async () => {
    process.env.CF_ACCESS_CLIENT_ID = 'client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'client-secret';
    const response = new Response(JSON.stringify(document));
    Object.defineProperty(response, 'url', {
      value: 'https://api.example.com/.well-known/void-platform',
    });
    let request: RequestInit | undefined;

    await discoverPlatform('https://api.example.com', async (_input, init) => {
      request = init;
      return response;
    });

    expect(request?.headers).toEqual({ Accept: 'application/json' });
    expect(request?.redirect).toBe('manual');
  });
});
