import { describe, expect, it } from 'vitest';
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
});
