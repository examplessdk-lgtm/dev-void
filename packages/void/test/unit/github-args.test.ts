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

    it('parses --workflow', () => {
      const result = parseGithubArgs(['connect', '--workflow', '.github/workflows/ci.yml']);
      expect(result).toEqual({
        subcommand: 'connect',
        projectName: '',
        installationId: undefined,
        repo: undefined,
        branch: undefined,
        executor: undefined,
        workflowPath: '.github/workflows/ci.yml',
      });
    });

    it('throws when --workflow has no value', () => {
      expect(() => parseGithubArgs(['connect', '--workflow'])).toThrow(
        'github: --workflow requires a value.',
      );
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

  describe('update', () => {
    it('parses update with no args', () => {
      expect(parseGithubArgs(['update'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses update with a project name', () => {
      expect(parseGithubArgs(['update', 'my-project'])).toEqual({
        subcommand: 'update',
        projectName: 'my-project',
        branch: undefined,
        executor: undefined,
      });
    });

    it('parses --project flag', () => {
      expect(parseGithubArgs(['update', '--project', 'my-project'])).toEqual({
        subcommand: 'update',
        projectName: 'my-project',
        branch: undefined,
        executor: undefined,
      });
    });

    it('--project flag is an alias for the positional', () => {
      const positional = parseGithubArgs(['update', 'my-project']);
      const flag = parseGithubArgs(['update', '--project', 'my-project']);
      expect(flag).toEqual(positional);
    });

    it('parses --branch flag', () => {
      expect(parseGithubArgs(['update', '--branch', 'release'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: 'release',
        executor: undefined,
      });
    });

    it('trims a whitespace-padded --branch value', () => {
      expect(parseGithubArgs(['update', '--branch', '  main  '])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: 'main',
        executor: undefined,
      });
    });

    it('rejects --branch with whitespace-only value', () => {
      expect(() => parseGithubArgs(['update', '--branch', '   '])).toThrow(
        'github: --branch requires a value.',
      );
    });

    it('parses --executor container', () => {
      expect(parseGithubArgs(['update', '--executor', 'container'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: undefined,
        executor: 'container',
      });
    });

    it('parses --executor github_actions', () => {
      expect(parseGithubArgs(['update', '--executor', 'github_actions'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: undefined,
        executor: 'github_actions',
      });
    });

    it('parses --workflow', () => {
      expect(parseGithubArgs(['update', '--workflow', '.github/workflows/ci.yml'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: undefined,
        executor: undefined,
        workflowPath: '.github/workflows/ci.yml',
      });
    });

    it('throws when --workflow has no value', () => {
      expect(() => parseGithubArgs(['update', '--workflow'])).toThrow(
        'github: --workflow requires a value.',
      );
    });

    it('parses project name with both flags together', () => {
      expect(
        parseGithubArgs([
          'update',
          'my-project',
          '--branch',
          'main',
          '--executor',
          'github_actions',
        ]),
      ).toEqual({
        subcommand: 'update',
        projectName: 'my-project',
        branch: 'main',
        executor: 'github_actions',
      });
    });

    it('rejects --branch with no value', () => {
      expect(() => parseGithubArgs(['update', '--branch'])).toThrow(
        'github: --branch requires a value.',
      );
    });

    it('rejects --branch with empty value', () => {
      expect(() => parseGithubArgs(['update', '--branch', ''])).toThrow(
        'github: --branch requires a value.',
      );
    });

    it('rejects --project with no value', () => {
      expect(() => parseGithubArgs(['update', '--project'])).toThrow(
        'github: --project requires a value.',
      );
    });

    it('rejects --project when positional already set', () => {
      expect(() => parseGithubArgs(['update', 'my-project', '--project', 'other'])).toThrow(
        "github: Unexpected argument 'other'.",
      );
    });

    it('rejects --executor with no value', () => {
      expect(() => parseGithubArgs(['update', '--executor'])).toThrow(
        'github: --executor requires a value.',
      );
    });

    it('rejects invalid --executor value', () => {
      expect(() => parseGithubArgs(['update', '--executor', 'docker'])).toThrow(
        'github: invalid --executor (expected container|github_actions).',
      );
    });

    it('rejects unknown flag', () => {
      expect(() => parseGithubArgs(['update', '--unknown'])).toThrow(
        "github: Unexpected argument '--unknown'.",
      );
    });

    it('rejects extra positional after project name', () => {
      expect(() => parseGithubArgs(['update', 'my-project', 'extra'])).toThrow(
        "github: Unexpected argument 'extra'.",
      );
    });
  });

  describe('status', () => {
    it('parses status with no args', () => {
      expect(parseGithubArgs(['status'])).toEqual({
        subcommand: 'status',
        projectName: '',
      });
    });

    it('parses status with a project name', () => {
      expect(parseGithubArgs(['status', 'my-project'])).toEqual({
        subcommand: 'status',
        projectName: 'my-project',
      });
    });

    it('parses --project flag', () => {
      expect(parseGithubArgs(['status', '--project', 'my-project'])).toEqual({
        subcommand: 'status',
        projectName: 'my-project',
      });
    });

    it('--project flag is an alias for the positional', () => {
      const positional = parseGithubArgs(['status', 'my-project']);
      const flag = parseGithubArgs(['status', '--project', 'my-project']);
      expect(flag).toEqual(positional);
    });

    it('rejects --project when positional already set', () => {
      expect(() => parseGithubArgs(['status', 'my-project', '--project', 'other'])).toThrow(
        "github: Unexpected argument 'other'.",
      );
    });

    it('rejects --project with no value', () => {
      expect(() => parseGithubArgs(['status', '--project'])).toThrow(
        'github: --project requires a value.',
      );
    });

    it('rejects an unknown flag', () => {
      expect(() => parseGithubArgs(['status', '--nope'])).toThrow(
        "github: Unexpected argument '--nope'.",
      );
    });

    it('rejects an extra positional after project name', () => {
      expect(() => parseGithubArgs(['status', 'my-project', 'extra'])).toThrow(
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

  describe('join', () => {
    it('parses join with no args', () => {
      expect(parseGithubArgs(['join'])).toEqual({ subcommand: 'join' });
    });

    it('rejects extra positional', () => {
      expect(() => parseGithubArgs(['join', 'x'])).toThrow("github: Unexpected argument 'x'.");
    });

    it('rejects a flag', () => {
      expect(() => parseGithubArgs(['join', '--flag'])).toThrow(
        "github: Unexpected argument '--flag'.",
      );
    });
  });

  describe('unknown subcommand', () => {
    it('throws on empty args', () => {
      expect(() => parseGithubArgs([])).toThrow(
        'github: Usage: void github <install|installations|connect|update|status|link|join>.',
      );
    });

    it('throws on unknown subcommand', () => {
      expect(() => parseGithubArgs(['unknown'])).toThrow(
        'github: Usage: void github <install|installations|connect|update|status|link|join>.',
      );
    });
  });
});
