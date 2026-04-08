import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { parseRouteFilename } from '../../src/router/parse-filename';

describe('parseRouteFilename', () => {
  describe('static routes', () => {
    it('simple file', () => {
      const r = parseRouteFilename('api/hello.ts');
      expect(r.pattern).toBe('/api/hello');
      expect(r.methods).toEqual([]);
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(false);
      expect(r.env).toBeNull();
    });

    it('nested file', () => {
      const r = parseRouteFilename('api/users/profile.ts');
      expect(r.pattern).toBe('/api/users/profile');
    });

    it('index file becomes directory', () => {
      const r = parseRouteFilename('api/users/index.ts');
      expect(r.pattern).toBe('/api/users');
    });

    it('root index', () => {
      const r = parseRouteFilename('index.ts');
      expect(r.pattern).toBe('/');
    });
  });

  describe('file extensions', () => {
    it('.ts', () => {
      expect(parseRouteFilename('hello.ts').pattern).toBe('/hello');
    });

    it('.js', () => {
      expect(parseRouteFilename('hello.js').pattern).toBe('/hello');
    });

    it('.mts', () => {
      expect(parseRouteFilename('hello.mts').pattern).toBe('/hello');
    });

    it('.mjs', () => {
      expect(parseRouteFilename('hello.mjs').pattern).toBe('/hello');
    });
  });

  describe('environment suffixes', () => {
    it('.dev suffix', () => {
      const r = parseRouteFilename('debug.dev.ts');
      expect(r.pattern).toBe('/debug');
      expect(r.env).toBe('dev');
    });

    it('.prod suffix', () => {
      const r = parseRouteFilename('health.prod.ts');
      expect(r.pattern).toBe('/health');
      expect(r.env).toBe('prod');
    });
  });

  describe('dynamic params', () => {
    it('single param', () => {
      const r = parseRouteFilename('users/[id].ts');
      expect(r.pattern).toBe('/users/:id');
      expect(r.params).toEqual(['id']);
      expect(r.catchAll).toBe(false);
    });

    it('multiple params in nested dirs', () => {
      const r = parseRouteFilename('api/[org]/[repo]/index.ts');
      expect(r.pattern).toBe('/api/:org/:repo');
      expect(r.params).toEqual(['org', 'repo']);
    });

    it('param as directory with static child', () => {
      const r = parseRouteFilename('api/[org]/[repo]/issues.ts');
      expect(r.pattern).toBe('/api/:org/:repo/issues');
      expect(r.params).toEqual(['org', 'repo']);
    });
  });

  describe('catch-all', () => {
    it('named catch-all', () => {
      const r = parseRouteFilename('hello/[...name].ts');
      expect(r.pattern).toBe('/hello/:name{.+}');
      expect(r.params).toEqual(['name']);
      expect(r.catchAll).toBe(true);
    });

    it('unnamed catch-all (404)', () => {
      const r = parseRouteFilename('[...].ts');
      expect(r.pattern).toBe('/*');
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(true);
    });
  });

  describe('catch-all patterns work with Hono', () => {
    it('unnamed catch-all matches any path', async () => {
      const { pattern } = parseRouteFilename('[...].ts');
      const app = new Hono();
      app.get(pattern, (c) => c.text('ok'));

      const res = await app.request('/any/deep/path');
      expect(res.status).toBe(200);
    });

    it('named catch-all captures path param', async () => {
      const { pattern } = parseRouteFilename('files/[...path].ts');
      const app = new Hono();
      app.get(pattern, (c) => c.text(c.req.param('path')!));

      const res = await app.request('/files/a/b/c');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('a/b/c');
    });
  });

  describe('route groups', () => {
    it('single group', () => {
      const r = parseRouteFilename('api/(admin)/users.ts');
      expect(r.pattern).toBe('/api/users');
    });

    it('nested group', () => {
      const r = parseRouteFilename('api/(admin)/(v2)/reports.ts');
      expect(r.pattern).toBe('/api/reports');
    });

    it('group with dynamic param', () => {
      const r = parseRouteFilename('api/(public)/[id].ts');
      expect(r.pattern).toBe('/api/:id');
      expect(r.params).toEqual(['id']);
    });
  });

  describe('complex combinations', () => {
    it('nested dynamic with env', () => {
      const r = parseRouteFilename('api/users/[id].dev.ts');
      expect(r.pattern).toBe('/api/users/:id');
      expect(r.env).toBe('dev');
      expect(r.params).toEqual(['id']);
    });

    it('preserves filePath', () => {
      const r = parseRouteFilename('api/hello.ts');
      expect(r.filePath).toBe('api/hello.ts');
    });

    it('methods starts empty (populated by scanner)', () => {
      const r = parseRouteFilename('api/hello.ts');
      expect(r.methods).toEqual([]);
    });
  });
});
