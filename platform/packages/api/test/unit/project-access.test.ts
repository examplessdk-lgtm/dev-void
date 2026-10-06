import { describe, expect, it } from 'vite-plus/test';
import { roleLosesDeployCapability } from '../../src/project-access.ts';
import type { ProjectRole } from '../../src/types.ts';

describe('roleLosesDeployCapability', () => {
  const previousRoles: ReadonlyArray<ProjectRole> = ['reader', 'collaborator', 'admin', 'owner'];
  const nextRoles: ReadonlyArray<ProjectRole | null> = [null, 'reader', 'collaborator', 'admin'];
  const cases = previousRoles.flatMap((previous) =>
    nextRoles.map((next) => ({
      previous,
      next,
      loses: previous !== 'reader' && (next === null || next === 'reader'),
    })),
  );

  it.each(cases)('$previous -> $next: $loses', ({ previous, next, loses }) => {
    expect(roleLosesDeployCapability(previous, next)).toBe(loses);
  });
});
