import { describe, it, expect } from 'vite-plus/test';
import type { Db } from '../../src/db.ts';
import { provisionBindings } from '../../src/provisioning/provision.ts';
import { RESERVED_BINDING_NAMES, isReservedBindingName } from '../../src/reserved-bindings.ts';
import type { DeployManifest } from '../../src/types.ts';

/**
 * The deploy pipeline concatenates the platform's bindings with the user's
 * vars and secrets into one `metadata.bindings` array, and Cloudflare resolves
 * duplicate names last-wins with no error. Every platform-injected name must
 * therefore be rejected as a user binding — and the two lists live in
 * different modules, so nothing but a test keeps them in step.
 *
 * These tests call the REAL producers with a manifest that declares no user
 * bindings, so everything that comes back is platform-injected by definition.
 */

// `getProjectResources` is the only db call `provisionBindings` makes for a
// manifest with no resource bindings.
const stubDb = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Db;

const EMPTY_MANIFEST: DeployManifest = { version: 1, bindings: {} };

async function platformBindingNames(): Promise<ReadonlyArray<string>> {
  const provisioned = await provisionBindings(
    stubDb,
    'test-account',
    'test-token',
    'proj_abc123',
    EMPTY_MANIFEST,
    'void-proxy',
    {
      projectSlug: 'my-app',
      proxyToken: 'test-proxy-token',
      emailSenderDomain: 'mail.voidcloud.dev',
    },
  );
  return provisioned.map((binding) => binding.name);
}

describe('reserved binding names cover every platform-injected binding', () => {
  it('reserves every name provisionBindings emits for a manifest with no user bindings', async () => {
    const provisioned = await provisionBindings(
      stubDb,
      'test-account',
      'test-token',
      'proj_abc123',
      EMPTY_MANIFEST,
      'void-proxy',
      {
        projectSlug: 'my-app',
        proxyToken: 'test-proxy-token',
        emailSenderDomain: 'mail.voidcloud.dev',
      },
    );
    expect(provisioned.length).toBeGreaterThan(0);
    for (const binding of provisioned) {
      expect(
        isReservedBindingName(binding.name),
        `provisionBindings emits "${binding.name}" — add it to RESERVED_BINDING_NAMES`,
      ).toBe(true);
    }
  });

  it('keeps retired sandbox identity and queue names reserved', () => {
    expect(isReservedBindingName('__VOID_USER_ID')).toBe(true);
    expect(isReservedBindingName('USAGE_EVENTS_QUEUE')).toBe(true);
  });

  it('reserves ASSETS, which the deploy route appends inline rather than via a builder', () => {
    expect(isReservedBindingName('ASSETS')).toBe(true);
  });

  it('names every binding the producers actually emit today', async () => {
    // The dual of the tests above: they catch a NEW platform binding that was
    // never reserved. This one catches a reserved name silently DROPPED from
    // the set. Retired Sandbox producer names are checked separately above.
    expect(new Set(await platformBindingNames())).toEqual(
      new Set([
        '__VOID_PROXY',
        '__PROJECT_ID',
        '__VOID_PROXY_TOKEN',
        '__VOID_PROJECT_SLUG',
        '__VOID_EMAIL_DOMAIN',
      ]),
    );
  });

  it('reserves SEND_EMAIL even though no worker receives that binding today', () => {
    // Outbound mail goes through `__VOID_PROXY/email/send`; the proxy holds
    // the account-level send_email binding. Reserved anyway so the name stays
    // free for custom-domain email and cannot collide with framework code
    // that still references it.
    expect(isReservedBindingName('SEND_EMAIL')).toBe(true);
  });

  it('leaves ordinary user binding names alone', () => {
    for (const name of ['DB', 'KV', 'STORAGE', 'MY_QUEUE', 'STRIPE_KEY']) {
      expect(isReservedBindingName(name)).toBe(false);
    }
  });

  it('does NOT reserve a bare VOID_PROJECT_SLUG', () => {
    // There is exactly one project-slug binding and it is `__VOID_PROJECT_SLUG`
    // (what the framework reads). Reserving an undotted `VOID_PROJECT_SLUG`
    // nothing injects would only take a usable name away from users.
    expect(isReservedBindingName('VOID_PROJECT_SLUG')).toBe(false);
  });

  it('is exposed as a set so callers cannot mutate it into disagreement', () => {
    expect(RESERVED_BINDING_NAMES.has('__VOID_PROXY_TOKEN')).toBe(true);
  });
});

it('pins managed email to its deployment identity and reserves that binding', async () => {
  const args = [
    stubDb,
    'test-account',
    'test-token',
    'proj_abc123',
    { ...EMPTY_MANIFEST, emailProtocolVersion: 1 },
    'void-proxy',
    { projectSlug: 'my-app', proxyToken: 'test-proxy-token', deploymentId: 'deploy_a' },
  ] as const;
  const bindings = await provisionBindings(...args);
  expect(bindings).toContainEqual({
    type: 'plain_text',
    name: '__VOID_EMAIL_DEPLOYMENT_ID',
    text: 'deploy_a',
  });
  expect(isReservedBindingName('__VOID_EMAIL_DEPLOYMENT_ID')).toBe(true);
  await expect(
    provisionBindings(
      ...(args.slice(0, 6) as [(typeof args)[0], string, string, string, (typeof args)[4], string]),
      { projectSlug: 'my-app', proxyToken: 'test-proxy-token' },
    ),
  ).rejects.toThrow('deployment identity');
});
