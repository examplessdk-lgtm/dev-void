import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageRouter } from '../../src/pages/client';
import { parseCacheFor } from '../../src/pages/prefetch';

function stubClientGlobals() {
  const documentStub = {
    createElement: vi.fn(() => ({})),
    getElementById: vi.fn((id: string) => {
      if (id === '__VOID_PAGE_DATA__') {
        return {
          textContent: JSON.stringify({
            component: 'home',
            props: {},
          }),
        };
      }
      if (id === 'app') {
        return {
          getAttribute: vi.fn(() => null),
        };
      }
      return null;
    }),
    head: {
      appendChild: vi.fn(),
    },
    querySelector: vi.fn(() => null),
  };

  vi.stubGlobal('document', documentStub);
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    location: {
      origin: 'http://localhost',
      pathname: '/',
      search: '',
    },
    scrollX: 0,
    scrollY: 0,
  });

  return documentStub;
}

describe('createPageRouter prefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects non-GET methods before route side effects', async () => {
    const documentStub = stubClientGlobals();
    const homeLoader = vi.fn(async () => ({ default: {} }));
    const usersLoader = vi.fn(async () => ({ default: {} }));
    const layoutLoader = vi.fn(async () => ({ default: {} }));
    const matchRoute = vi.fn(() => 'users');

    const { router } = await createPageRouter({
      adapter: {
        applyUpdate: vi.fn(),
        createDeferred: vi.fn(() => ({})),
        isLoading: vi.fn(() => false),
        rejectDeferred: vi.fn((_ref, error) => error),
        resolveDeferred: vi.fn((_ref, value) => value),
      },
      components: {
        home: homeLoader,
        layout: layoutLoader,
        users: usersLoader,
      },
      layoutTree: {
        users: ['layout'],
      },
      matchRoute,
      prefetchDefaultCacheFor: parseCacheFor('30s'),
      prefetchHoverDelay: 75,
      routeMeta: {
        users: {},
      },
      viewTransitions: false,
    });

    expect(() => router.prefetch('/users', { method: 'POST' })).toThrow(
      'router.prefetch() only supports GET requests.',
    );
    expect(matchRoute).not.toHaveBeenCalled();
    expect(usersLoader).not.toHaveBeenCalled();
    expect(layoutLoader).not.toHaveBeenCalled();
    expect(documentStub.createElement).not.toHaveBeenCalled();
    expect(documentStub.head.appendChild).not.toHaveBeenCalled();
  });
});
