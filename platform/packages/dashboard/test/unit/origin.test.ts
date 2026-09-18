import type { Context } from 'hono';
import { describe, expect, it } from 'vite-plus/test';
import { dashboardRequestOrigin } from '../../lib/origin.ts';

const context = (url: string, host: string, configured?: string) =>
  ({
    req: { url, header: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) },
    env: { DASHBOARD_URL: configured },
  }) as unknown as Context;

describe('dashboard request origin', () => {
  it('preserves the configured origin through Workers Assets loopback dispatch', () => {
    expect(
      dashboardRequestOrigin(
        context('http://localhost/account', 'dash.example.com', 'https://dash.example.com'),
      ),
    ).toBe('https://dash.example.com');
  });
  it('does not replace real alternate origins or unrecognized hosts', () => {
    expect(
      dashboardRequestOrigin(
        context(
          'https://alternate.workers.dev/account',
          'dash.example.com',
          'https://dash.example.com',
        ),
      ),
    ).toBe('https://alternate.workers.dev');
    expect(
      dashboardRequestOrigin(
        context('http://localhost/account', 'unrecognized.example.com', 'https://dash.example.com'),
      ),
    ).toBe('http://localhost');
    expect(dashboardRequestOrigin(context('http://localhost/account', 'dash.example.com'))).toBe(
      'http://localhost',
    );
  });
});
