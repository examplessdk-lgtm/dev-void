import { describe, it, expect } from 'vite-plus/test';
import {
  isAdminSuspended,
  REASON_REQUESTS_EXCEEDED,
  REASON_SANDBOX_RUNTIME_EXCEEDED,
} from '../../src/suspension.ts';
import {
  evaluateRequestLimit,
  evaluateAiLimit,
  type CounterState,
} from '../../src/usage-counter.ts';

describe('isAdminSuspended', () => {
  it('returns false for null (not suspended)', () => {
    expect(isAdminSuspended(null)).toBe(false);
  });

  it('returns false for usage-limit reason', () => {
    expect(isAdminSuspended(REASON_REQUESTS_EXCEEDED)).toBe(false);
  });

  it('returns false for sandbox runtime usage-limit reason', () => {
    expect(isAdminSuspended(REASON_SANDBOX_RUNTIME_EXCEEDED)).toBe(false);
  });

  it('does not treat sandbox_runtime_exceeded as admin suspension', () => {
    expect(isAdminSuspended('sandbox_runtime_exceeded')).toBe(false);
  });

  it('returns true for admin_suspended', () => {
    expect(isAdminSuspended('admin_suspended')).toBe(true);
  });

  it('returns true for unknown suspension reason', () => {
    expect(isAdminSuspended('some_other_reason')).toBe(true);
  });

  it('does not treat requests_exceeded as admin suspension', () => {
    expect(isAdminSuspended('requests_exceeded')).toBe(false);
  });

  it('treats abuse and manual as admin suspension', () => {
    expect(isAdminSuspended('abuse')).toBe(true);
    expect(isAdminSuspended('manual')).toBe(true);
  });
});

describe('evaluateRequestLimit (real implementation)', () => {
  function makeState(overrides: Partial<CounterState> = {}): CounterState {
    return {
      ownerUserId: 'u1',
      totalRequests: 0,
      totalNeurons: 0,
      totalSandboxSeconds: 0,
      plan: 'free',
      billingPeriodStart: new Date().toISOString(),
      requestsSuspended: false,
      aiSuspended: false,
      sandboxRuntimeSuspended: false,
      projectSlugs: {},
      projectOwnershipStarts: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {},
      ...overrides,
    };
  }

  it('returns false when under the limit', () => {
    const state = makeState({ totalRequests: 50_000 });
    expect(evaluateRequestLimit(state, 1)).toBe(false);
  });

  it('returns true when exceeding the limit', () => {
    // free plan has 3_000_000 requests/month
    const state = makeState({ totalRequests: 3_000_000 });
    expect(evaluateRequestLimit(state, 1)).toBe(true);
  });

  it('accounts for incoming requests in the check', () => {
    // limit is strictly less-than: 2_999_999 + 1 = 3_000_000 which equals limit → exceeds
    const state = makeState({ totalRequests: 2_999_998 });
    expect(evaluateRequestLimit(state, 1)).toBe(false); // 2_999_999 < 3_000_000
    expect(evaluateRequestLimit(state, 2)).toBe(true); // 3_000_000 >= 3_000_000
  });
});

describe('evaluateAiLimit (real implementation)', () => {
  function makeState(overrides: Partial<CounterState> = {}): CounterState {
    return {
      ownerUserId: 'u1',
      totalRequests: 0,
      totalNeurons: 0,
      totalSandboxSeconds: 0,
      plan: 'free',
      billingPeriodStart: new Date().toISOString(),
      requestsSuspended: false,
      aiSuspended: false,
      sandboxRuntimeSuspended: false,
      projectSlugs: {},
      projectOwnershipStarts: {},
      projectNeurons: {},
      historicalNeurons: 0,
      historicalAiWindows: {},
      ...overrides,
    };
  }

  it('returns false when under the AI limit', () => {
    const state = makeState({ totalNeurons: 1_000 });
    expect(evaluateAiLimit(state)).toBe(false);
  });

  it('returns true when exceeding the AI limit', () => {
    // free plan has 100_000 neurons/month
    const state = makeState({ totalNeurons: 100_001 });
    expect(evaluateAiLimit(state)).toBe(true);
  });
});
