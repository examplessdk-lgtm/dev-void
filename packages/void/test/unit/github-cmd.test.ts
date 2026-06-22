import { describe, expect, it } from 'vite-plus/test';
import type { GithubInstallation } from '../../src/cli/client.ts';
import { formatInstallations, parseGithubRepoFullName } from '../../src/cli/github-cmd.ts';

describe('parseGithubRepoFullName', () => {
  it('extracts owner/repo from a plain https GitHub URL', () => {
    expect(parseGithubRepoFullName('https://github.com/acme/my-app')).toBe('acme/my-app');
  });

  it('strips the .git suffix', () => {
    expect(parseGithubRepoFullName('https://github.com/acme/my-app.git')).toBe('acme/my-app');
  });

  it('returns null for a non-GitHub URL', () => {
    expect(parseGithubRepoFullName('https://gitlab.com/acme/my-app')).toBe(null);
  });

  it('returns null for a non-GitHub URL with .git suffix', () => {
    expect(parseGithubRepoFullName('https://bitbucket.org/acme/my-app.git')).toBe(null);
  });

  it('returns null for null input', () => {
    expect(parseGithubRepoFullName(null)).toBe(null);
  });

  it('returns null for an unparseable string', () => {
    expect(parseGithubRepoFullName('not-a-url')).toBe(null);
  });

  it('returns null for a GitHub URL with only one path segment', () => {
    expect(parseGithubRepoFullName('https://github.com/acme')).toBe(null);
  });
});

function makeInstall(
  overrides: Partial<GithubInstallation> & Pick<GithubInstallation, 'account_login'>,
): GithubInstallation {
  return {
    id: 'inst_1',
    installation_id: '42',
    account_id: '1',
    account_type: 'User',
    repositories: [],
    repository_selection: 'all',
    status: 'active',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('formatInstallations', () => {
  it('includes account_login, account_type, selection, repo count, and status', () => {
    const result = formatInstallations([makeInstall({ account_login: 'acme' })]);
    expect(result).toContain('acme');
    expect(result).toContain('User');
    expect(result).toContain('all');
    expect(result).toContain('0 repos');
    expect(result).toContain('active');
  });

  it('lists repo full names for a selected installation', () => {
    const inst = makeInstall({
      account_login: 'org',
      account_type: 'Organization',
      repository_selection: 'selected',
      repositories: [
        { full_name: 'org/alpha', id: 1 },
        { full_name: 'org/beta', id: 2 },
      ],
    });
    const result = formatInstallations([inst]);
    expect(result).toContain('org/alpha');
    expect(result).toContain('org/beta');
    expect(result).toContain('selected');
    expect(result).toContain('2 repos');
  });

  it('does not list repos for an all-selection installation', () => {
    const inst = makeInstall({
      account_login: 'user',
      repository_selection: 'all',
      repositories: [{ full_name: 'user/private', id: 99 }],
    });
    const result = formatInstallations([inst]);
    // The repo list block should not appear (no bullet points)
    expect(result).not.toContain('user/private');
    expect(result).toContain('all');
  });

  it('returns an empty string for an empty list', () => {
    expect(formatInstallations([])).toBe('');
  });

  it('separates multiple installations with a blank line', () => {
    const a = makeInstall({ account_login: 'alice' });
    const b = makeInstall({ account_login: 'bob' });
    const result = formatInstallations([a, b]);
    expect(result).toContain('alice');
    expect(result).toContain('bob');
    // Two blocks separated by double newline
    expect(result).toContain('\n\n');
  });

  it('does not list repos for a selected installation with zero repos', () => {
    const inst = makeInstall({
      account_login: 'empty-org',
      repository_selection: 'selected',
      repositories: [],
    });
    const result = formatInstallations([inst]);
    expect(result).toContain('selected');
    expect(result).toContain('0 repos');
    // No bullet character since repo list is empty
    expect(result).not.toContain('•');
  });
});
