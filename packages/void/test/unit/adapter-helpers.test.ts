import { describe, expect, it } from 'vite-plus/test';
import {
  getValidationErrors,
  isModifiedEvent,
  mergeDataIntoHref,
} from '../../src/pages/adapter-helpers.ts';

describe('getValidationErrors', () => {
  it('returns the errors record from an action error body', () => {
    expect(getValidationErrors({ errors: { title: 'Required' } })).toEqual({ title: 'Required' });
  });

  it.each([undefined, null, 'oops', {}, { errors: null }, { errors: ['Required'] }])(
    'returns null for %j',
    (body) => {
      expect(getValidationErrors(body)).toBeNull();
    },
  );
});

describe('mergeDataIntoHref', () => {
  it('serializes dates and appends before the hash', () => {
    expect(
      mergeDataIntoHref('/events?sort=asc#top', { from: new Date('2026-01-02T00:00:00.000Z') }),
    ).toBe('/events?sort=asc&from=2026-01-02T00%3A00%3A00.000Z#top');
  });

  it('returns the href unchanged without data', () => {
    expect(mergeDataIntoHref('/users#team')).toBe('/users#team');
  });
});

describe('isModifiedEvent', () => {
  function click(overrides: Partial<Record<string, unknown>> = {}, target: string | null = null) {
    return {
      currentTarget: { getAttribute: () => target } as unknown as EventTarget,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      ...overrides,
    } as Parameters<typeof isModifiedEvent>[0];
  }

  it('treats a plain primary click on a same-tab link as unmodified', () => {
    expect(isModifiedEvent(click())).toBe(false);
    expect(isModifiedEvent(click({}, '_self'))).toBe(false);
  });

  it.each([
    [{ ctrlKey: true }, null],
    [{ metaKey: true }, null],
    [{ shiftKey: true }, null],
    [{ altKey: true }, null],
    [{ button: 1 }, null],
    [{}, '_blank'],
  ])('treats %j with target %j as modified', (overrides, target) => {
    expect(isModifiedEvent(click(overrides, target))).toBe(true);
  });
});
