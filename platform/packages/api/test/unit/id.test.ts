import { describe, expect, it } from 'vite-plus/test';
import { signJwt } from '../../src/auth/jwt.ts';
import { generateId, isProjectId } from '../../src/id.ts';

describe('isProjectId', () => {
  it('accepts generated project ids', () => {
    for (let i = 0; i < 100; i++) {
      expect(isProjectId(generateId('proj'))).toBe(true);
    }
  });

  it('rejects the signed part of a login JWT', async () => {
    const jwt = await signJwt({ sub: 'user_1', login: 'octocat', aud: 'api' }, 'secret');
    const [header, body] = jwt.split('.');
    expect(isProjectId(`${header}.${body}`)).toBe(false);
  });

  it('rejects other prefixes, lengths, and characters', () => {
    for (const value of [
      generateId('res'),
      'proj_1',
      'proj_a1b2c3d4e5f6a',
      'proj_A1B2C3D4E5F6',
      'proj_a1b2c3d4e5f.',
      'proj_a1b2c3d4e5f6\n',
      ' proj_a1b2c3d4e5f6',
      '',
      undefined,
      42,
    ]) {
      expect(isProjectId(value)).toBe(false);
    }
  });
});
