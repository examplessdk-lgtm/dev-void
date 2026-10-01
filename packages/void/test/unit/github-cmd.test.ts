import { describe, expect, it } from 'vite-plus/test';
import type { GithubConnection, GithubInstallation } from '../../src/cli/client.ts';
import {
  DEFAULT_WORKFLOW_PATH,
  describeConnectError,
  describeUpdateError,
  formatConnection,
  formatInstallations,
  isValidWorkflowPath,
  parseGithubRepoFullName,
} from '../../src/cli/github-cmd.ts';

describe('describeConnectError', () => {
  it('returns already-connected message for 409 / "project already connected"', () => {
    const msg = describeConnectError(409, 'project already connected');
    expect(msg).toBe('This project is already connected to a GitHub repository.');
  });

  it('returns not-active message for 409 / "installation is not active"', () => {
    const msg = describeConnectError(409, 'installation is not active');
    expect(msg).toBe('Installation is not active. Re-install the GitHub App and try again.');
  });

  it('returns not-accessible message for 400 / "repository not accessible by installation"', () => {
    const msg = describeConnectError(400, 'repository not accessible by installation');
    expect(msg).toBe(
      'Repository not accessible by this installation. Check the App has access to it.',
    );
  });

  it('leaves 403 explanations to the operation-aware client', () => {
    const msg = describeConnectError(403, 'forbidden');
    expect(msg).toBeNull();
  });

  it('returns not-found message for 404 / "project not found"', () => {
    const msg = describeConnectError(404, 'project not found');
    expect(msg).toBe('Project or installation not found.');
  });

  it('returns not-found message for 404 / "installation not found"', () => {
    const msg = describeConnectError(404, 'installation not found');
    expect(msg).toBe('Project or installation not found.');
  });

  it('returns null for an unrecognised status / code', () => {
    expect(describeConnectError(500, undefined)).toBeNull();
  });

  it('returns null for an unrecognised 409 code', () => {
    expect(describeConnectError(409, 'some other conflict')).toBeNull();
  });
});

describe('describeUpdateError', () => {
  it('returns a connect-first message for 404 / "connection not found"', () => {
    const msg = describeUpdateError(404, 'connection not found');
    expect(msg).toBe(
      'This project is not connected to a GitHub repository. Run `void github connect` first.',
    );
  });

  it('falls back to the connect mapping for other 404 codes', () => {
    expect(describeUpdateError(404, 'project not found')).toBe(
      'Project or installation not found.',
    );
  });

  it('falls back to the connect mapping for 403', () => {
    expect(describeUpdateError(403, 'forbidden')).toBeNull();
  });

  it('returns null for an unrecognised status / code', () => {
    expect(describeUpdateError(500, undefined)).toBeNull();
  });
});

describe('isValidWorkflowPath', () => {
  it('accepts the scaffolded default path', () => {
    expect(isValidWorkflowPath(DEFAULT_WORKFLOW_PATH)).toBe(true);
  });

  it('accepts a custom .yml path under .github/workflows/', () => {
    expect(isValidWorkflowPath('.github/workflows/deploy-prod.yml')).toBe(true);
  });

  it('accepts a .yaml extension', () => {
    expect(isValidWorkflowPath('.github/workflows/ci.yaml')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidWorkflowPath('')).toBe(false);
  });

  it('rejects a path outside .github/workflows/', () => {
    expect(isValidWorkflowPath('scripts/deploy.yml')).toBe(false);
  });

  it('rejects a non-yaml extension', () => {
    expect(isValidWorkflowPath('.github/workflows/deploy.txt')).toBe(false);
  });

  it('rejects a path containing ".."', () => {
    expect(isValidWorkflowPath('.github/workflows/../../evil.yml')).toBe(false);
  });
});

function makeConnection(overrides: Partial<GithubConnection> = {}): GithubConnection {
  return {
    id: 'conn_1',
    project_id: 'proj_1',
    installation_id: '42',
    repo_full_name: 'acme/my-app',
    repository_id: '99',
    branch: 'main',
    build_executor: 'github_actions',
    workflow_path: '.github/workflows/void-deploy.yml',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('formatConnection', () => {
  it('shows repo, branch, executor, and workflow path', () => {
    const out = formatConnection(makeConnection());
    expect(out).toContain('acme/my-app');
    expect(out).toContain('main');
    expect(out).toContain('github_actions');
    expect(out).toContain('.github/workflows/void-deploy.yml');
  });

  it('does not mark the workflow unused for github_actions', () => {
    expect(formatConnection(makeConnection())).not.toContain('unused');
  });

  it('marks the workflow unused for the container executor', () => {
    const out = formatConnection(makeConnection({ build_executor: 'container' }));
    expect(out).toContain('container');
    expect(out).toContain('unused for container builds');
  });

  it('labels each field', () => {
    const out = formatConnection(makeConnection());
    expect(out).toContain('Repository');
    expect(out).toContain('Branch');
    expect(out).toContain('Build executor');
    expect(out).toContain('Deploy workflow');
  });
});

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
  it('includes account_login, account_type, installation_id, selection, repo count, and status', () => {
    const result = formatInstallations([makeInstall({ account_login: 'acme' })]);
    expect(result).toContain('acme');
    expect(result).toContain('User');
    expect(result).toContain('[id: 42]');
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
