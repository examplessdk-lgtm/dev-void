import { describe, expect, it } from 'vite-plus/test';
import { parseGenArgs } from '../../src/cli/gen-args.ts';

describe('parseGenArgs', () => {
  it('errors on no subcommand', () => {
    expect(() => parseGenArgs([])).toThrow(
      'gen: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>.',
    );
  });

  it('errors on unknown subcommand', () => {
    expect(() => parseGenArgs(['unknown'])).toThrow(
      'gen: Usage: void gen <model|migration|route|middleware|ssr|cron|queue>.',
    );
  });

  describe('model', () => {
    it('parses model with no columns', () => {
      expect(parseGenArgs(['model', 'posts'])).toEqual({
        subcommand: 'model',
        name: 'posts',
        columns: [],
      });
    });

    it('parses model with columns', () => {
      expect(
        parseGenArgs(['model', 'posts', 'title:string', 'body:text', 'views:integer']),
      ).toEqual({
        subcommand: 'model',
        name: 'posts',
        columns: [
          { name: 'title', type: 'string', nullable: false },
          { name: 'body', type: 'text', nullable: false },
          { name: 'views', type: 'integer', nullable: false },
        ],
      });
    });

    it('parses nullable columns', () => {
      expect(parseGenArgs(['model', 'posts', 'bio:text?'])).toEqual({
        subcommand: 'model',
        name: 'posts',
        columns: [{ name: 'bio', type: 'text', nullable: true }],
      });
    });

    it('supports all column types', () => {
      const types = ['string', 'text', 'datetime', 'integer', 'boolean', 'real', 'blob'];
      for (const type of types) {
        const result = parseGenArgs(['model', 't', `col:${type}`]);
        expect(result).toEqual({
          subcommand: 'model',
          name: 't',
          columns: [{ name: 'col', type, nullable: false }],
        });
      }
    });

    it('errors on missing name', () => {
      expect(() => parseGenArgs(['model'])).toThrow(
        'gen: Usage: void gen model <name> [columns...].',
      );
    });

    it('errors on invalid model name', () => {
      expect(() => parseGenArgs(['model', '1bad'])).toThrow(
        'gen: Model name must be lowercase alphanumeric with underscores and no leading digits.',
      );
    });

    it('errors on uppercase model name', () => {
      expect(() => parseGenArgs(['model', 'Posts'])).toThrow(
        'gen: Model name must be lowercase alphanumeric with underscores and no leading digits.',
      );
    });

    it('errors on invalid column format', () => {
      expect(() => parseGenArgs(['model', 'posts', 'bad'])).toThrow(
        "gen: Invalid column format 'bad'. Use name:type or name:type?.",
      );
    });

    it('errors on unknown column type', () => {
      expect(() => parseGenArgs(['model', 'posts', 'col:varchar'])).toThrow(
        "gen: Unknown column type 'varchar'. Use one of: string, text, datetime, integer, boolean, real, blob.",
      );
    });
  });

  describe('migration', () => {
    it('parses migration name', () => {
      expect(parseGenArgs(['migration', 'add_avatar_to_users'])).toEqual({
        subcommand: 'migration',
        name: 'add_avatar_to_users',
      });
    });

    it('errors on missing name', () => {
      expect(() => parseGenArgs(['migration'])).toThrow('gen: Usage: void gen migration <name>.');
    });

    it('errors on extra argument', () => {
      expect(() => parseGenArgs(['migration', 'foo', 'bar'])).toThrow(
        "gen: Unexpected argument 'bar'.",
      );
    });

    it('errors on invalid name', () => {
      expect(() => parseGenArgs(['migration', '1bad'])).toThrow(
        'gen: Migration name must be lowercase alphanumeric with underscores and no leading digits.',
      );
    });
  });

  describe('route', () => {
    it('parses route with default GET method', () => {
      expect(parseGenArgs(['route', 'api/health'])).toEqual({
        subcommand: 'route',
        path: 'api/health',
        methods: ['get'],
      });
    });

    it('parses route with explicit methods', () => {
      expect(parseGenArgs(['route', 'api/users', '--methods', 'get,post'])).toEqual({
        subcommand: 'route',
        path: 'api/users',
        methods: ['get', 'post'],
      });
    });

    it('strips leading slashes', () => {
      expect(parseGenArgs(['route', '/api/health'])).toEqual({
        subcommand: 'route',
        path: 'api/health',
        methods: ['get'],
      });
    });

    it('errors on missing path', () => {
      expect(() => parseGenArgs(['route'])).toThrow(
        'gen: Usage: void gen route <path> [--methods get,post,...].',
      );
    });

    it('errors on extra argument', () => {
      expect(() => parseGenArgs(['route', 'api/foo', 'bar'])).toThrow(
        "gen: Unexpected argument 'bar'.",
      );
    });

    it('errors on unknown HTTP method', () => {
      expect(() => parseGenArgs(['route', 'api/foo', '--methods', 'get,head'])).toThrow(
        "gen: Unknown HTTP method 'head'. Use one of: get, post, put, patch, delete.",
      );
    });
  });

  describe('ssr', () => {
    it('parses ssr with no framework (auto-detect)', () => {
      expect(parseGenArgs(['ssr'])).toEqual({
        subcommand: 'ssr',
        framework: undefined,
      });
    });

    it.each(['react', 'vue', 'svelte', 'solid'])('parses ssr with --%s', (framework) => {
      expect(parseGenArgs(['ssr', `--${framework}`])).toEqual({ subcommand: 'ssr', framework });
    });

    it('errors on multiple framework flags', () => {
      expect(() => parseGenArgs(['ssr', '--react', '--vue'])).toThrow(
        'gen: Specify only one framework flag.',
      );
    });

    it('errors on unexpected positional', () => {
      expect(() => parseGenArgs(['ssr', 'extra'])).toThrow("gen: Unexpected argument 'extra'.");
    });
  });

  describe.each([
    ['middleware', 'Middleware'],
    ['cron', 'Cron'],
    ['queue', 'Queue'],
  ])('%s', (subcommand, label) => {
    it('parses a name', () => {
      expect(parseGenArgs([subcommand, 'auth'])).toEqual({ subcommand, name: 'auth' });
    });

    it('allows hyphenated names', () => {
      expect(parseGenArgs([subcommand, 'rate-limit'])).toEqual({ subcommand, name: 'rate-limit' });
    });

    it('errors on missing name', () => {
      expect(() => parseGenArgs([subcommand])).toThrow(
        `gen: Usage: void gen ${subcommand} <name>.`,
      );
    });

    it('errors on extra argument', () => {
      expect(() => parseGenArgs([subcommand, 'auth', 'extra'])).toThrow(
        "gen: Unexpected argument 'extra'.",
      );
    });

    it.each(['1bad', '--foo'])('rejects the invalid name %s', (name) => {
      expect(() => parseGenArgs([subcommand, name])).toThrow(
        `gen: ${label} name must be lowercase alphanumeric with underscores or hyphens and no leading digits.`,
      );
    });
  });
});
