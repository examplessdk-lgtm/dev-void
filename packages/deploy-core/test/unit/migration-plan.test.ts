import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalSql,
  classifySqlMigration,
  getMigrationPlanHashInput,
  isSingleStatement,
  splitSqlStatements,
  tokenizeSql,
} from '../../src/index.ts';

describe('SQL migration classification', () => {
  it('normalizes SQL before classification and hashing', () => {
    expect(canonicalSql('\uFEFFSELECT 1;\r\nSELECT 2;\r')).toBe('SELECT 1;\nSELECT 2;\n');
  });

  it('ignores semicolons in comments, strings, and quoted identifiers', () => {
    const sql = '-- ;\nSELECT \'a;\'\'b\', "a;""b", `a;``b`, [a;] /* ; */;';
    expect(isSingleStatement(sql)).toBe(true);
    expect(classifySqlMigration(sql)).toEqual({ kind: 'single-statement', stability: 'stable' });
    expect(isSingleStatement('SELECT 1; SELECT 2;')).toBe(false);
  });

  it('splits only standalone breakpoint comments outside literals', () => {
    const first =
      "INSERT INTO logs VALUES('--> statement-breakpoint');\n/* --> statement-breakpoint */";
    expect(classifySqlMigration(`${first}\n--> statement-breakpoint\nSELECT 2;`)).toEqual({
      kind: 'breakpoint-framed',
      stability: 'stable',
      statements: [first, 'SELECT 2;'],
    });
  });

  it('records the explicit policy marker on unframed SQL', () => {
    expect(classifySqlMigration('SELECT 1; SELECT 2;')).toEqual({
      kind: 'legacy-unsplit-multi-statement',
      stability: 'legacy',
      allowLegacy: false,
    });
    expect(
      classifySqlMigration('-- void:allow-unsplit-multi-statement\nSELECT 1; SELECT 2;'),
    ).toEqual({
      kind: 'legacy-unsplit-multi-statement',
      stability: 'legacy',
      allowLegacy: true,
    });
  });

  it('leaves execution-policy decisions to the caller', () => {
    expect(classifySqlMigration('--> statement-breakpoint')).toEqual({
      kind: 'breakpoint-framed',
      stability: 'stable',
      statements: [],
    });
    expect(classifySqlMigration('BEGIN; SELECT 1; COMMIT;').kind).toBe(
      'legacy-unsplit-multi-statement',
    );
  });

  it('preserves the classifier-v1 hash preimage', () => {
    expect(
      getMigrationPlanHashInput({
        kind: 'legacy-unsplit-multi-statement',
        stability: 'legacy',
        allowLegacy: true,
        name: '001.sql',
        dialect: 'sqlite',
        classifierVersion: 1,
        sqlHash: 'sha256:sql',
      }),
    ).toEqual({
      kind: 'legacy-unsplit-multi-statement',
      stability: 'legacy',
      name: '001.sql',
      dialect: 'sqlite',
      classifierVersion: 1,
      sqlHash: 'sha256:sql',
    });
  });
});

describe('SQL statement splitting', () => {
  it('splits a multi-line CREATE TABLE and following INSERTs into separate statements', () => {
    const sql = [
      '-- seed',
      'CREATE TABLE `notes` (',
      '\t`id` integer PRIMARY KEY NOT NULL,',
      '\t`body` text NOT NULL',
      ');',
      "INSERT INTO `notes` (`body`) VALUES ('hello');",
      "INSERT INTO `notes` (`body`) VALUES ('world');",
      '/* trailing comment */',
      '',
    ].join('\r\n');
    expect(splitSqlStatements(sql)).toEqual([
      [
        '-- seed',
        'CREATE TABLE `notes` (',
        '\t`id` integer PRIMARY KEY NOT NULL,',
        '\t`body` text NOT NULL',
        ');',
      ].join('\n'),
      "INSERT INTO `notes` (`body`) VALUES ('hello');",
      "INSERT INTO `notes` (`body`) VALUES ('world');",
    ]);
  });

  it('does not split on semicolons inside strings, identifiers, or comments', () => {
    const sql =
      'CREATE TABLE notes (message TEXT DEFAULT \'a;b\', "c;d" TEXT); -- x;y\nINSERT INTO notes DEFAULT VALUES';
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE notes (message TEXT DEFAULT \'a;b\', "c;d" TEXT);',
      '-- x;y\nINSERT INTO notes DEFAULT VALUES',
    ]);
  });

  it('returns null for trigger bodies it cannot split safely', () => {
    const sql = [
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, updated_at TEXT);',
      'CREATE TRIGGER notes_touch AFTER UPDATE ON notes BEGIN',
      "  UPDATE notes SET updated_at = datetime('now') WHERE id = NEW.id;",
      'END;',
    ].join('\n');
    expect(splitSqlStatements(sql)).toBeNull();
  });
});

describe('SQLite tokenization', () => {
  it('keeps escaped quotes and unterminated comments in their lexical regions', () => {
    const sql = 'SELECT \'a\'\';b\', "a"";b", `a``;b`, [a;] /* unclosed';
    const regions = Array.from(tokenizeSql(sql))
      .filter((segment) => segment.kind !== 'sql')
      .map((segment) => [segment.kind, sql.slice(segment.start, segment.end)]);
    expect(regions).toEqual([
      ['string', "'a'';b'"],
      ['ident-quote', '"a"";b"'],
      ['ident-quote', '`a``;b`'],
      ['ident-quote', '[a;]'],
      ['block-comment', '/* unclosed'],
    ]);
  });
});
