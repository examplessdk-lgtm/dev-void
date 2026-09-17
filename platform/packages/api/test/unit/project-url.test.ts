import { describe, it, expect } from 'vite-plus/test';
import { projectUrl, projectWithUrl } from '../../src/project-url.ts';

const project = { id: 'proj_123456abcdef', slug: 'kitchen-sink' };
describe('canonical application URLs', () => {
  it('preserves existing platform URL and response behavior', () => {
    expect(projectUrl(project, {} as never)).toBe('https://kitchen-sink.void.app');
    expect(projectWithUrl(project, {} as never)).toBe(project);
    expect(projectUrl(project, { SITE_DOMAIN: 'custom.example.com' } as never)).toBe(
      'https://kitchen-sink.custom.example.com',
    );
  });
  it('returns the workers.dev hostname, then switches to the domain without changing the project', () => {
    const application = {
      baseDomain: 'test.workers.dev',
      zoneName: '',
      dedicatedZone: false,
      workersDev: { subdomain: 'test', installationId: 'team-123456abcdef' },
    };
    const testing = { PLATFORM_APPLICATION: JSON.stringify(application) } as never;
    expect(projectWithUrl(project, testing)).toEqual({
      ...project,
      url: 'https://void-123456abcdef-kitchen-sink-123456abcdef.test.workers.dev',
    });
    expect(
      projectUrl(project, {
        PLATFORM_APPLICATION: JSON.stringify({
          ...application,
          zoneName: 'example.com',
          baseDomain: 'example.com',
        }),
      } as never),
    ).toBe('https://kitchen-sink.example.com');
    expect(project).not.toHaveProperty('url');
  });
});
