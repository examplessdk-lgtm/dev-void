import { describe, expect, it } from 'vite-plus/test';
import { parseGithubArgs } from '../../src/cli/github-args.ts';

describe('parseGithubArgs', () => {
  describe('install', () => {
    it('parses install with no args', () => {
      expect(parseGithubArgs(['install'])).toEqual({ subcommand: 'install' });
    });

    it('rejects extra positional', () => {
      expect(() => parseGithubArgs(['install', 'extra'])).toThrow(
        "github: Unexpected argument 'extra'.",
      );
    });

    it('rejects a flag', () => {
      expect(() => parseGithubArgs(['install', '--flag'])).toThrow(
        "github: Unexpected argument '--flag'.",
      );
    });
  });

  describe('installations', () => {
    it('parses installations with no args', () => {
      expect(parseGithubArgs(['installations'])).toEqual({ subcommand: 'installations' });
    });

    it('rejects extra positional', () => {
      expect(() => parseGithubArgs(['installations', 'extra'])).toThrow(
        "github: Unexpected argument 'extra'.",
      );
    });

    it('rejects a flag', () => {
      expect(() => parseGithubArgs(['installations', '--flag'])).toThrow(
        "github: Unexpected argument '--flag'.",
      );
    });
  });

  describe('connect', () => {
    it('parses connect with no args', () => {
      expect(parseGithubArgs(['connect'])).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses connect with a project name', () => {
      expect(parseGithubArgs(['connect', 'my-project'])).toEqual({
        subcommand: 'connect',
        projectName: 'my-project',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses --installation flag', () => {
      const result = parseGithubArgs(['connect', '--installation', '42']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: '42',
        repo: undefined,
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses --repo flag', () => {
      const result = parseGithubArgs(['connect', '--repo', 'owner/name']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: 'owner/name',
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses --branch flag', () => {
      const result = parseGithubArgs(['connect', '--branch', 'main']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: undefined,
        branch: 'main',
        executor: undefined,
      });
    });

    it('parses --executor container', () => {
      const result = parseGithubArgs(['connect', '--executor', 'container']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: 'container',
      });
    });

    it('parses --executor github_actions', () => {
      const result = parseGithubArgs(['connect', '--executor', 'github_actions']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: 'github_actions',
      });
    });

    it('parses --project flag', () => {
      const result = parseGithubArgs(['connect', '--project', 'my-project']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: 'my-project',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: undefined,
      });
    });

    it('--project flag is an alias for the positional', () => {
      const positional = parseGithubArgs(['connect', 'my-project']);
      const flag = parseGithubArgs(['connect', '--project', 'my-project']);
      expect(flag).toEqual(positional);
    });

    it('rejects --project when positional already set', () => {
      expect(() => parseGithubArgs(['connect', 'my-project', '--project', 'other'])).toThrow(
        "github: Unexpected argument 'other'.",
      );
    });

    it('rejects --project when --project already set', () => {
      expect(() =>
        parseGithubArgs(['connect', '--project', 'first', '--project', 'second']),
      ).toThrow("github: Unexpected argument 'second'.");
    });

    it('parses all flags together with project name', () => {
      expect(
        parseGithubArgs([
          'connect',
          'my-project',
          '--installation',
          '42',
          '--repo',
          'owner/repo',
          '--branch',
          'main',
          '--executor',
          'container',
        ]),
      ).toEqual({
        subcommand: 'connect',
        projectName: 'my-project',
        installationId: '42',
        repo: 'owner/repo',
        branch: 'main',
        executor: 'container',
      });
    });

    it('parses all flags together with --project flag', () => {
      expect(
        parseGithubArgs([
          'connect',
          '--project',
          'my-project',
          '--installation',
          '42',
          '--repo',
          'owner/repo',
          '--branch',
          'main',
          '--executor',
          'container',
        ]),
      ).toEqual({
        subcommand: 'connect',
        projectName: 'my-project',
        installationId: '42',
        repo: 'owner/repo',
        branch: 'main',
        executor: 'container',
      });
    });

    it('rejects --installation with no value', () => {
      expect(() => parseGithubArgs(['connect', '--installation'])).toThrow(
        'github: --installation requires a value.',
      );
    });

    it('rejects --installation with empty value', () => {
      expect(() => parseGithubArgs(['connect', '--installation', ''])).toThrow(
        'github: --installation requires a value.',
      );
    });

    it('rejects --installation with whitespace-only value', () => {
      expect(() => parseGithubArgs(['connect', '--installation', '   '])).toThrow(
        'github: --installation requires a value.',
      );
    });

    it('rejects --repo with no value', () => {
      expect(() => parseGithubArgs(['connect', '--repo'])).toThrow(
        'github: --repo requires a value.',
      );
    });

    it('rejects --repo with empty value', () => {
      expect(() => parseGithubArgs(['connect', '--repo', ''])).toThrow(
        'github: --repo requires a value.',
      );
    });

    it('rejects --branch with no value', () => {
      expect(() => parseGithubArgs(['connect', '--branch'])).toThrow(
        'github: --branch requires a value.',
      );
    });

    it('rejects --branch with empty value', () => {
      expect(() => parseGithubArgs(['connect', '--branch', ''])).toThrow(
        'github: --branch requires a value.',
      );
    });

    it('rejects --project with no value', () => {
      expect(() => parseGithubArgs(['connect', '--project'])).toThrow(
        'github: --project requires a value.',
      );
    });

    it('rejects --project with empty value', () => {
      expect(() => parseGithubArgs(['connect', '--project', ''])).toThrow(
        'github: --project requires a value.',
      );
    });

    it('rejects --executor with no value', () => {
      expect(() => parseGithubArgs(['connect', '--executor'])).toThrow(
        'github: --executor requires a value.',
      );
    });

    it('rejects --executor with empty value', () => {
      expect(() => parseGithubArgs(['connect', '--executor', ''])).toThrow(
        'github: --executor requires a value.',
      );
    });

    it('rejects invalid --executor value', () => {
      expect(() => parseGithubArgs(['connect', '--executor', 'docker'])).toThrow(
        'github: invalid --executor (expected container|github_actions).',
      );
    });

    it('rejects unknown flag', () => {
      expect(() => parseGithubArgs(['connect', '--unknown'])).toThrow(
        "github: Unexpected argument '--unknown'.",
      );
    });

    it('rejects extra positional after project name', () => {
      expect(() => parseGithubArgs(['connect', 'my-project', 'extra'])).toThrow(
        "github: Unexpected argument 'extra'.",
      );
    });
  });

  describe('link', () => {
    it('parses link with no args', () => {
      expect(parseGithubArgs(['link'])).toEqual({ subcommand: 'link' });
    });

    it('rejects extra positional', () => {
      expect(() => parseGithubArgs(['link', 'extra'])).toThrow(
        "github: Unexpected argument 'extra'.",
      );
    });

    it('rejects a flag', () => {
      expect(() => parseGithubArgs(['link', '--flag'])).toThrow(
        "github: Unexpected argument '--flag'.",
      );
    });
  });

  describe('unknown subcommand', () => {
    it('throws on empty args', () => {
      expect(() => parseGithubArgs([])).toThrow(
        'github: Usage: void github <install|installations|connect|link>.',
      );
    });

    it('throws on unknown subcommand', () => {
      expect(() => parseGithubArgs(['unknown'])).toThrow(
        'github: Usage: void github <install|installations|connect|link>.',
      );
    });
  });
});
