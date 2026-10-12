import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizePath } from 'vite';
import { describe, it, expect } from 'vite-plus/test';
import {
  extractCssImports,
  rewriteCssImportForVirtualModule,
} from '../../src/pages/islands-plugin.ts';

/** Resolve a POSIX-style absolute path to a platform-correct path with forward slashes. */
const p = (posix: string) => normalizePath(resolve(posix));

describe('rewriteCssImportForVirtualModule', () => {
  it('extracts only authored static CSS imports', () => {
    const root = mkdtempSync(join(tmpdir(), 'void-island-css-'));
    try {
      const path = join(root, 'page.tsx');
      writeFileSync(
        path,
        `import './real.css';\nconst sample = \`example\nimport './fake.css'\`;\nawait import('./later.css');`,
      );
      expect(extractCssImports(path)).toBe('@import "./real.css";');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('rewrites relative CSS import to absolute path', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "./global.css"',
      './global.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe(`import "${p('/project/pages/global.css')}";`);
  });

  it('rewrites parent-relative CSS import to absolute path', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "../styles/theme.css"',
      '../styles/theme.css',
      p('/project/pages/blog/index.tsx'),
    );
    expect(result).toBe(`import "${p('/project/pages/styles/theme.css')}";`);
  });

  it('preserves bare specifiers (package imports)', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "@void/md/theme.css"',
      '@void/md/theme.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "@void/md/theme.css";');
  });

  it('preserves absolute specifiers', () => {
    const result = rewriteCssImportForVirtualModule(
      'import "/absolute/path/style.css"',
      '/absolute/path/style.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "/absolute/path/style.css";');
  });

  it('trims whitespace from non-relative imports', () => {
    const result = rewriteCssImportForVirtualModule(
      '  import "some-lib/styles.css"  ',
      'some-lib/styles.css',
      p('/project/pages/layout.tsx'),
    );
    expect(result).toBe('import "some-lib/styles.css";');
  });
});
