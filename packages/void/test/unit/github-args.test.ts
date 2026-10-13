import { describe, expect, it } from 'vite-plus/test';
import { parseGithubArgs } from '../../src/cli/github-args.ts';

describe('parseGithubArgs', () => {
  describe.each(['install', 'installations', 'link', 'join'] as const)('%s', (subcommand) => {
    it('parses with no args', () => {
      expect(parseGithubArgs([subcommand])).toEqual({ subcommand });
    });

    it.each(['extra', '--flag'])('rejects %s', (arg) => {
      expect(() => parseGithubArgs([subcommand, arg])).toThrow(
        `github: Unexpected argument '${arg}'.`,
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

    it('parses --workflow', () => {
      expect(parseGithubArgs(['update', '--workflow', '.github/workflows/ci.yml'])).toEqual({
        subcommand: 'update',
        projectName: '',
        branch: undefined,
        executor: undefined,
        workflowPath: '.github/workflows/ci.yml',
      });
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

    it('rejects --project when positional already set', () => {
      expect(() => parseGithubArgs(['update', 'my-project', '--project', 'other'])).toThrow(
        "github: Unexpected argument 'other'.",
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

  describe.each(['connect', 'update'] as const)('%s --executor', (subcommand) => {
    it.each(['container', 'github_actions'] as const)('parses %s', (executor) => {
      expect(parseGithubArgs([subcommand, '--executor', executor])).toEqual({
        subcommand,
        projectName: '',
        executor,
      });
    });

    it('rejects an invalid value', () => {
      expect(() => parseGithubArgs([subcommand, '--executor', 'docker'])).toThrow(
        'github: invalid --executor (expected container|github_actions).',
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

    it('rejects --project when positional already set', () => {
      expect(() => parseGithubArgs(['status', 'my-project', '--project', 'other'])).toThrow(
        "github: Unexpected argument 'other'.",
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

  describe('disconnect', () => {
    it('parses with no args (defaults)', () => {
      expect(parseGithubArgs(['disconnect'])).toEqual({
        subcommand: 'disconnect',
        projectName: '',
        yes: false,
      });
    });

    it('parses a positional project', () => {
      expect(parseGithubArgs(['disconnect', 'my-app'])).toEqual({
        subcommand: 'disconnect',
        projectName: 'my-app',
        yes: false,
      });
    });

    it('parses --project', () => {
      expect(parseGithubArgs(['disconnect', '--project', 'my-app'])).toEqual({
        subcommand: 'disconnect',
        projectName: 'my-app',
        yes: false,
      });
    });

    it('parses --yes and -y', () => {
      expect(parseGithubArgs(['disconnect', 'my-app', '--yes'])).toEqual({
        subcommand: 'disconnect',
        projectName: 'my-app',
        yes: true,
      });
      expect(parseGithubArgs(['disconnect', '-y', 'my-app'])).toEqual({
        subcommand: 'disconnect',
        projectName: 'my-app',
        yes: true,
      });
    });

    it('throws on a second positional', () => {
      expect(() => parseGithubArgs(['disconnect', 'a', 'b'])).toThrow(
        "github: Unexpected argument 'b'.",
      );
    });

    it('throws on an unknown flag', () => {
      expect(() => parseGithubArgs(['disconnect', '--nope'])).toThrow(
        "github: Unexpected argument '--nope'.",
      );
    });
  });

  it.each<[subcommand: string, flag: string, value: string | undefined]>([
    ['connect', '--installation', undefined],
    ['connect', '--installation', ''],
    ['connect', '--installation', '   '],
    ['connect', '--repo', undefined],
    ['connect', '--repo', ''],
    ['connect', '--branch', undefined],
    ['connect', '--branch', ''],
    ['connect', '--executor', undefined],
    ['connect', '--executor', ''],
    ['connect', '--workflow', undefined],
    ['connect', '--project', undefined],
    ['connect', '--project', ''],
    ['update', '--branch', undefined],
    ['update', '--branch', ''],
    ['update', '--branch', '   '],
    ['update', '--executor', undefined],
    ['update', '--workflow', undefined],
    ['update', '--project', undefined],
    ['status', '--project', undefined],
    ['disconnect', '--project', undefined],
  ])('%s %s rejects the value %j', (subcommand, flag, value) => {
    const args = value === undefined ? [subcommand, flag] : [subcommand, flag, value];
    expect(() => parseGithubArgs(args)).toThrow(`github: ${flag} requires a value.`);
  });

  describe('unknown subcommand', () => {
    it('throws on empty args', () => {
      expect(() => parseGithubArgs([])).toThrow(
        'github: Usage: void github <install|installations|connect|update|status|disconnect|link|join>.',
      );
    });

    it('throws on unknown subcommand', () => {
      expect(() => parseGithubArgs(['unknown'])).toThrow(
        'github: Usage: void github <install|installations|connect|update|status|disconnect|link|join>.',
      );
    });
  });
});
