import { describe, expect, it } from 'vitest';
import { isPublicDashboardPath } from '../../middleware/01.auth.ts';

describe('dashboard auth middleware', () => {
  it('allows unauthenticated public pages and built assets', () => {
    expect(isPublicDashboardPath('/login')).toBe(true);
    expect(isPublicDashboardPath('/logout')).toBe(true);
    expect(isPublicDashboardPath('/auth/callback')).toBe(true);
    expect(isPublicDashboardPath('/assets/pages-client.js')).toBe(true);
    expect(isPublicDashboardPath('/assets/layout.css')).toBe(true);
  });

  it('keeps dashboard routes behind auth', () => {
    expect(isPublicDashboardPath('/')).toBe(false);
    expect(isPublicDashboardPath('/projects/proj_123')).toBe(false);
    expect(isPublicDashboardPath('/settings')).toBe(false);
    expect(isPublicDashboardPath('/assetz/layout.css')).toBe(false);
  });
});
