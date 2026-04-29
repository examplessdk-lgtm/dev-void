import { describe, expect, it } from 'vitest';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import type { ScanResult } from '../../src/router/scan.ts';

describe('generateRouteTypes', () => {
  it('generates route type declarations for single-method routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('declare module "void/routes"');
    expect(dts).toContain('"/api/hello"');
    expect(dts).toContain('GET: {');
    expect(dts).toContain('typeof import("../routes/api/hello.ts")');
    expect(dts).toContain('input:');
    expect(dts).toContain('output:');
  });

  it('generates multi-method routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/users',
          methods: ['GET', 'POST'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/users/index.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('GET: {');
    expect(dts).toContain('POST: {');
    expect(dts).toContain('typeof import("../routes/api/users/index.ts")');
  });

  it('skips routes with no methods', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/legacy',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/legacy.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).not.toContain('/api/legacy');
  });

  it('handles dynamic params in patterns', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/users/:id',
          methods: ['GET'],
          params: ['id'],
          catchAll: false,
          env: null,
          filePath: 'api/users/[id].ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('"/api/users/:id"');
    expect(dts).toContain('typeof import("../routes/api/users/[id].ts")');
  });

  it('includes Serialize and ExtractInput helper types', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('type Serialize<T>');
    expect(dts).toContain('type ExtractInput<V>');
    expect(dts).toContain('StandardSchemaV1');
  });

  it('includes export {} so declare module is an augmentation', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };
    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('export {}');
  });

  it('emits RouteName and RewriteDestination aliases on void/routes', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/hello',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/hello.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    // Both exports must live inside the `declare module "void/routes"` block so
    // consumers importing from `void/routes` pick them up after codegen.
    const moduleBlockStart = dts.indexOf('declare module "void/routes"');
    expect(moduleBlockStart).toBeGreaterThan(-1);
    const moduleBlock = dts.slice(moduleBlockStart);

    expect(moduleBlock).toContain('export type RouteName = keyof RouteMap;');
    // The `(string & {})` trick is load-bearing: it keeps route-name
    // autocomplete while still accepting dynamic paths like `/users/${id}`.
    expect(moduleBlock).toContain('export type RewriteDestination = RouteName | (string & {});');
  });

  it('generates correct relative paths', () => {
    const scan: ScanResult = {
      routes: [
        {
          pattern: '/api/deep/nested',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'api/deep/nested.ts',
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    // Should have relative path from .void to routes
    expect(dts).toContain('../routes/api/deep/nested.ts');
  });

  it('generates PageActionMap for pages with actions', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users',
            params: [],
            catchAll: false,
            componentPath: 'users/index.vue',
            serverPath: 'users/index.server.ts',
            methods: ['loader', 'action'],
            componentId: 'users',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('interface PageActionMap');
    expect(dts).toContain('"/users"');
    expect(dts).toContain('typeof import("../pages/users/index.server.ts")');
    expect(dts).toContain('body:');
  });

  it('generates params in PageActionMap for dynamic routes', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users/:id',
            params: ['id'],
            catchAll: false,
            componentPath: 'users/[id].vue',
            serverPath: 'users/[id].server.ts',
            methods: ['loader', 'action'],
            componentId: 'users/[id]',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('"/users/:id"');
    expect(dts).toContain('params: { id: string }');
  });

  it('generates WebSocketRouteMap entries', () => {
    const scan: ScanResult = {
      routes: [],
      websockets: [
        {
          pattern: '/chat/:room',
          methods: [],
          params: ['room'],
          catchAll: false,
          env: null,
          filePath: 'chat/[room].ws.ts',
          className: 'ChatRoomWs',
          bindingName: 'ChatRoomWs',
          mode: 'room',
          hasAuthGate: true,
        },
      ],
      middleware: [],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('interface WebSocketRouteMap');
    expect(dts).toContain('"/chat/:room"');
    expect(dts).toContain('typeof import("../routes/chat/[room].ws.ts")');
    expect(dts).toContain('client:');
    expect(dts).toContain('server:');
    expect(dts).toContain('params: RouteParams<["room"]>');
  });

  it('skips pages without action in PageActionMap', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/about',
            params: [],
            catchAll: false,
            componentPath: 'about.vue',
            serverPath: 'about.server.ts',
            methods: ['loader'],
            componentId: 'about',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('export interface PageActionMap {}');
    expect(dts).not.toContain('"/about"');
  });

  it('generates PageActionMap with named actions', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users',
            params: [],
            catchAll: false,
            componentPath: 'users/index.vue',
            serverPath: 'users/index.server.ts',
            methods: ['loader', 'actions'],
            componentId: 'users',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('interface PageActionMap');
    expect(dts).toContain('"/users"');
    expect(dts).toContain('[K in keyof');
    expect(dts).toContain('["actions"]');
    expect(dts).toContain('ParseActionUrl<U>["action"]');
  });

  it('generates PageActionMap for named actions with dynamic params', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users/:id',
            params: ['id'],
            catchAll: false,
            componentPath: 'users/[id].vue',
            serverPath: 'users/[id].server.ts',
            methods: ['loader', 'actions'],
            componentId: 'users/[id]',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages');

    expect(dts).toContain('interface PageActionMap');
    expect(dts).toContain('"/users/:id"');
    expect(dts).toContain('["actions"]');
    expect(dts).toContain('params: { id: string }');
  });

  it('errors when both action and actions are present', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users',
            params: [],
            catchAll: false,
            componentPath: 'users/index.vue',
            serverPath: 'users/index.server.ts',
            methods: ['loader', 'action', 'actions'],
            componentId: 'users',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    expect(() =>
      generateRouteTypes(scan, '/project/routes', '/project/.void', '/project/pages'),
    ).toThrow(/both.*action.*actions/i);
  });

  it('omits PageActionMap when pagesDir is not provided', () => {
    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [],
      pages: {
        pages: [
          {
            pattern: '/users',
            params: [],
            catchAll: false,
            componentPath: 'users/index.vue',
            serverPath: 'users/index.server.ts',
            methods: ['loader', 'action'],
            componentId: 'users',
          },
        ],
        layouts: [],
        namedLayouts: [],
      },
    };

    const { dts } = generateRouteTypes(scan, '/project/routes', '/project/.void');

    expect(dts).toContain('export interface PageActionMap {}');
    expect(dts).not.toContain('"/users"');
  });
});
