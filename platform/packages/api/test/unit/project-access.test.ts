import { describe, expect, it } from 'vite-plus/test';
import { hasProjectCapability, PROJECT_ROLE_CAPABILITIES } from '../../src/project-access.ts';
import type { ProjectCapability, ProjectRole } from '../../src/types.ts';

const capabilities: ReadonlyArray<ProjectCapability> = [
  'read',
  'deploy',
  'configure',
  'settings',
  'members',
  'delete',
];

describe('project role capabilities', () => {
  const expected: Record<ProjectRole, ReadonlyArray<ProjectCapability>> = {
    reader: ['read'],
    collaborator: ['read', 'deploy', 'configure'],
    admin: ['read', 'deploy', 'configure', 'settings', 'members'],
    owner: ['read', 'deploy', 'configure', 'settings', 'members', 'delete'],
  };

  for (const role of Object.keys(expected) as Array<ProjectRole>) {
    it(`${role} has only its explicit capabilities`, () => {
      expect(PROJECT_ROLE_CAPABILITIES[role]).toEqual(expected[role]);
      for (const capability of capabilities) {
        expect(hasProjectCapability(role, capability)).toBe(expected[role].includes(capability));
      }
    });
  }
});
