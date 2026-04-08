import { describe, expect, it } from 'vitest';
import { parseProjectArgs } from '../../src/cli/project-args';

describe('parseProjectArgs', () => {
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
        'Unexpected argument: extra',
      );
    });
  });
});
