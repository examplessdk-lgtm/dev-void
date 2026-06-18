import { describe, expect, it } from 'vite-plus/test';
import { parseProjectArgs } from '../../src/cli/project-args.ts';

describe('parseProjectArgs', () => {
  describe('cancel', () => {
    it('parses cancel without a deployment id', () => {
      expect(parseProjectArgs(['cancel'])).toEqual({
        subcommand: 'cancel',
        deployId: '',
      });
    });

    it('parses cancel with a deployment id', () => {
      expect(parseProjectArgs(['cancel', 'dpl_123'])).toEqual({
        subcommand: 'cancel',
        deployId: 'dpl_123',
      });
    });

    it('errors on unexpected argument', () => {
      expect(() => parseProjectArgs(['cancel', 'dpl_123', 'extra'])).toThrow(
        "project: Unexpected argument 'extra'.",
      );
    });
  });

  describe('logs', () => {
    it('parses logs with no flags', () => {
      expect(parseProjectArgs(['logs'])).toEqual({
        subcommand: 'logs',
        filter: '',
        range: '1h',
        deployment: '',
        level: '',
      });
    });

    it('parses --filter, --range, --deployment, and --level together', () => {
      expect(
        parseProjectArgs([
          'logs',
          '--filter',
          'websocket',
          '--range',
          '30m',
          '--deployment',
          'dpl_abc',
          '--level',
          'error',
        ]),
      ).toEqual({
        subcommand: 'logs',
        filter: 'websocket',
        range: '30m',
        deployment: 'dpl_abc',
        level: 'error',
      });
    });

    it('accepts every documented level', () => {
      for (const v of ['error', 'warn', 'info', 'log', 'debug', 'all']) {
        const parsed = parseProjectArgs(['logs', '--level', v]);
        if (parsed.subcommand !== 'logs') {
          throw new Error('expected logs subcommand');
        }
        expect(parsed.level).toBe(v);
      }
    });

    it('rejects an invalid --level value', () => {
      expect(() => parseProjectArgs(['logs', '--level', 'fatal'])).toThrow(
        "project: Invalid --level 'fatal'. Use one of error|warn|info|log|debug|all.",
      );
    });

    it('rejects unknown flags', () => {
      expect(() => parseProjectArgs(['logs', '--bogus'])).toThrow(
        "project: Unexpected argument '--bogus'.",
      );
    });
  });

  describe('purge-cache', () => {
    it('parses purge-cache', () => {
      expect(parseProjectArgs(['purge-cache'])).toEqual({
        subcommand: 'purge-cache',
        projectSlug: '',
      });
    });

    it('parses purge-cache with --project', () => {
      expect(parseProjectArgs(['purge-cache', '--project', 'my-app'])).toEqual({
        subcommand: 'purge-cache',
        projectSlug: 'my-app',
      });
    });

    it('errors on unexpected argument', () => {
      expect(() => parseProjectArgs(['purge-cache', 'extra'])).toThrow(
        "project: Unexpected argument 'extra'.",
      );
    });
  });

  describe('unknown-flag rejection', () => {
    // `delete`/`logs`/`purge-cache` already reject unknown flags; status/link/
    // rollback/cancel previously captured a leading flag as the positional id.
    it('rejects an unknown flag for status instead of capturing it as the name', () => {
      expect(() => parseProjectArgs(['status', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('rejects an unknown flag for link', () => {
      expect(() => parseProjectArgs(['link', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('rejects an unknown flag for rollback', () => {
      expect(() => parseProjectArgs(['rollback', '--foo'])).toThrow(
        "project: Unknown flag '--foo'.",
      );
    });

    it('rejects an unknown flag for cancel', () => {
      expect(() => parseProjectArgs(['cancel', '--foo'])).toThrow("project: Unknown flag '--foo'.");
    });

    it('still accepts a valid positional id', () => {
      expect(parseProjectArgs(['status', 'my-app'])).toEqual({
        subcommand: 'status',
        name: 'my-app',
      });
    });
  });
});
