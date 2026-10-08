import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vite-plus/test';

type TestProject = {
  test: {
    name: string;
    include: Array<string>;
    exclude?: Array<string>;
    pool?: string;
    isolate?: boolean;
  };
};
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { default: config } = await import(
  new URL('../../../../vite.config.ts', import.meta.url).href
);
const projects = config.test.projects as Array<TestProject>;

function files(project: TestProject): Array<string> {
  return [...globSync(project.test.include, { cwd: root, exclude: project.test.exclude ?? [] })];
}

it('assigns every API integration file exactly once across its worker pools', () => {
  const discovered = [
    ...globSync('platform/packages/api/test/integration/**/*.test.ts', { cwd: root }),
  ];
  const selected = projects
    .filter((project) => project.test.name.startsWith('platform-api-integration'))
    .flatMap(files);
  expect(selected.sort()).toEqual(discovered.sort());
  expect(new Set(selected).size).toBe(discovered.length);
});

it('keeps process-timezone tests in forks', () => {
  for (const project of projects.filter((project) =>
    project.test.name.startsWith('platform-api-integration'),
  )) {
    for (const file of files(project)) {
      const source = readFileSync(join(root, file), 'utf8');
      if (/process\.env\.TZ|vi\.stubEnv\(['"]TZ['"]/.test(source)) {
        expect(project.test.pool ?? 'forks', file).toBe('forks');
      }
    }
  }
});

it('assigns every platform unit file exactly once and keeps PGlite files in their own project', () => {
  const discovered = [
    ...globSync('platform/packages/*/test/**/*.test.ts', {
      cwd: root,
      exclude: ['platform/packages/api/test/integration/**'],
    }),
  ];
  const unitProjects = projects.filter((project) => project.test.name.startsWith('platform-unit'));
  const selected = unitProjects.flatMap(files);
  expect(selected.sort()).toEqual(discovered.sort());
  expect(new Set(selected).size).toBe(discovered.length);
  for (const project of unitProjects) {
    for (const file of files(project)) {
      if (readFileSync(join(root, file), 'utf8').includes('@electric-sql/pglite')) {
        expect(project.test.name, file).toBe('platform-unit-pglite');
      }
    }
  }
});

it('assigns every SDK unit file exactly once including the subprocess project', () => {
  const discovered = [...globSync('packages/*/test/unit/**/*.test.ts', { cwd: root })];
  const selected = projects
    .filter((project) => ['unit', 'cli-unit'].includes(project.test.name))
    .flatMap(files);
  expect(selected.sort()).toEqual(discovered.sort());
  expect(new Set(selected).size).toBe(discovered.length);
});

it('keeps module isolation for every project', () => {
  for (const project of projects) {
    expect(project.test.isolate, project.test.name).not.toBe(false);
    expect(['threads', 'forks']).toContain(project.test.pool ?? 'forks');
  }
});
