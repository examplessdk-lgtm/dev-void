import { describe, expect, it } from 'vite-plus/test';
import { proxyCapabilityEnabled } from '../../src/capabilities.ts';

describe('proxy capabilities', () => {
  it('keeps managed Sandbox disabled when configuration is absent', () => {
    expect(proxyCapabilityEnabled(undefined, 'sandbox')).toBe(false);
  });

  it('overrides stale configured Sandbox enablement', () => {
    expect(proxyCapabilityEnabled('{"sandbox":true}', 'sandbox')).toBe(false);
  });
});
