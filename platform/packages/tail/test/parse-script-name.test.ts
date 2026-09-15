import { describe, it, expect } from 'vite-plus/test';
import { parseScriptName } from '../src/index.ts';

describe('parseScriptName', () => {
  it('parses versioned script name', () => {
    expect(parseScriptName('user-myapp-dpl_abc123')).toEqual({
      projectKey: 'user-myapp',
      deployId: 'dpl_abc123',
    });
  });

  it('parses legacy script name', () => {
    expect(parseScriptName('user-myapp')).toEqual({
      projectKey: 'user-myapp',
      deployId: '',
    });
  });

  it('handles hyphenated slugs with versioned name', () => {
    expect(parseScriptName('user-my-hyphenated-app-dpl_xyz789')).toEqual({
      projectKey: 'user-my-hyphenated-app',
      deployId: 'dpl_xyz789',
    });
  });

  it('filters out non-user, non-platform scripts', () => {
    expect(parseScriptName('void-api')).toBeNull();
    expect(parseScriptName('void-tail')).toBeNull();
    expect(parseScriptName('void-proxy')).toBeNull();
  });

  it('accepts void-dispatch under __platform-dispatch project key', () => {
    expect(parseScriptName('void-dispatch')).toEqual({
      projectKey: '__platform-dispatch',
      deployId: '',
    });
  });

  it('accepts void-dispatch-staging under __platform-dispatch-staging project key', () => {
    expect(parseScriptName('void-dispatch-staging')).toEqual({
      projectKey: '__platform-dispatch-staging',
      deployId: '',
    });
  });

  it('accepts the configured self-hosted dispatch Worker name', () => {
    expect(parseScriptName('void-company-dispatch', 'void-company-dispatch')).toEqual({
      projectKey: '__platform-dispatch',
      deployId: '',
    });
    expect(parseScriptName('void-other-dispatch', 'void-company-dispatch')).toBeNull();
  });
});
