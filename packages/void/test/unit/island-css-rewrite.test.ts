import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { normalizePath } from "vite";
import { rewriteCssImportForVirtualModule } from "../../src/pages/islands-plugin";

/** Resolve a POSIX-style absolute path to a platform-correct path with forward slashes. */
const p = (posix: string) => normalizePath(resolve(posix));

describe("rewriteCssImportForVirtualModule", () => {
  it("rewrites relative CSS import to absolute path", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "./global.css"',
      "./global.css",
      p("/project/pages/layout.tsx"),
    );
    expect(result).toBe(`import "${p("/project/pages/global.css")}";`);
  });

  it("rewrites parent-relative CSS import to absolute path", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "../styles/theme.css"',
      "../styles/theme.css",
      p("/project/pages/blog/index.tsx"),
    );
    expect(result).toBe(`import "${p("/project/pages/styles/theme.css")}";`);
  });

  it("preserves bare specifiers (package imports)", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "@void/md/theme.css"',
      "@void/md/theme.css",
      p("/project/pages/layout.tsx"),
    );
    expect(result).toBe('import "@void/md/theme.css";');
  });

  it("preserves absolute specifiers", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "/absolute/path/style.css"',
      "/absolute/path/style.css",
      p("/project/pages/layout.tsx"),
    );
    expect(result).toBe('import "/absolute/path/style.css";');
  });

  it("trims whitespace from non-relative imports", () => {
    const result = rewriteCssImportForVirtualModule(
      '  import "some-lib/styles.css"  ',
      "some-lib/styles.css",
      p("/project/pages/layout.tsx"),
    );
    expect(result).toBe('import "some-lib/styles.css";');
  });

  it("normalizes backslashes to forward slashes", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "./card.css"',
      "./card.css",
      p("/project/pages/components/deep/Card.tsx"),
    );
    expect(result).not.toContain("\\");
    expect(result).toBe(`import "${p("/project/pages/components/deep/card.css")}";`);
  });
});
