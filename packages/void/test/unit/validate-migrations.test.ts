import { describe, it, expect } from 'vitest';
import { isDestructive, validateMigrations } from '../../src/migrations/validate';

describe('isDestructive', () => {
  it('detects DROP TABLE', () => {
    expect(isDestructive('DROP TABLE users;')).toBe(true);
  });

  it('detects DROP TABLE case-insensitive', () => {
    expect(isDestructive('drop table users;')).toBe(true);
    expect(isDestructive('Drop Table users;')).toBe(true);
  });

  it('detects DROP COLUMN', () => {
    expect(isDestructive('ALTER TABLE users DROP COLUMN email;')).toBe(true);
  });

  it('detects ALTER TABLE ... RENAME', () => {
    expect(isDestructive('ALTER TABLE users RENAME TO people;')).toBe(true);
  });

  it('returns false for safe SQL', () => {
    expect(isDestructive('CREATE TABLE users (id TEXT PRIMARY KEY);')).toBe(false);
  });

  it('returns false for INSERT/UPDATE/DELETE', () => {
    expect(isDestructive("INSERT INTO users VALUES ('1', 'test');")).toBe(false);
    expect(isDestructive("UPDATE users SET name = 'test';")).toBe(false);
    expect(isDestructive("DELETE FROM users WHERE id = '1';")).toBe(false);
  });

  it('returns false for ADD COLUMN', () => {
    expect(isDestructive('ALTER TABLE users ADD COLUMN age INTEGER;')).toBe(false);
  });

  it('detects TRUNCATE TABLE', () => {
    expect(isDestructive('TRUNCATE TABLE users;')).toBe(true);
    expect(isDestructive('truncate table users;')).toBe(true);
  });

  it('detects TRUNCATE without TABLE keyword (PostgreSQL)', () => {
    expect(isDestructive('TRUNCATE users;')).toBe(true);
    expect(isDestructive('truncate users, posts;')).toBe(true);
  });
});

describe('validateMigrations', () => {
  it('returns validated files for safe migrations', () => {
    const result = validateMigrations([
      { name: '001_create.sql', sql: 'CREATE TABLE users (id TEXT);' },
      { name: '002_add_col.sql', sql: 'ALTER TABLE users ADD COLUMN name TEXT;' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: '001_create.sql',
      sql: 'CREATE TABLE users (id TEXT);',
      destructive: false,
    });
  });

  it('allows destructive migration with pragma', () => {
    const sql = '-- void:allow-destructive\nDROP TABLE old_users;';
    const result = validateMigrations([{ name: '003_drop.sql', sql }]);
    expect(result).toHaveLength(1);
    expect(result[0].destructive).toBe(true);
  });

  it('throws for destructive migration without pragma', () => {
    expect(() =>
      validateMigrations([{ name: '003_drop.sql', sql: 'DROP TABLE old_users;' }]),
    ).toThrow('Destructive migrations detected');
  });

  it('includes all failing filenames in error', () => {
    expect(() =>
      validateMigrations([
        { name: '003_drop.sql', sql: 'DROP TABLE a;' },
        { name: '004_rename.sql', sql: 'ALTER TABLE b RENAME TO c;' },
      ]),
    ).toThrow(/003_drop\.sql[\s\S]*004_rename\.sql/);
  });

  it('handles empty list', () => {
    const result = validateMigrations([]);
    expect(result).toEqual([]);
  });
});
