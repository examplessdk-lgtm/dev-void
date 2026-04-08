import { describe, expect, it } from 'vitest';
import { parseProjectArgs } from '../../src/cli/project-args';

describe('parseProjectArgs', () => {
  describe('purge-cache', () => {
    it('parses purge-cache', () => {
      expect(parseProjectArgs(['purge-cache'])).toEqual({
        subcommand: 'purge-cache',
      });
    });

    it('errors on unexpected argument', () => {
      expect(() => parseProjectArgs(['purge-cache', 'extra'])).toThrow(
        'Unexpected argument: extra',
      );
    });
  });
});
