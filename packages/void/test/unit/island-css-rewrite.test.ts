import { describe, it, expect } from "vitest";
import { rewriteCssImportForVirtualModule } from "../../src/pages/islands-plugin";

describe("rewriteCssImportForVirtualModule", () => {
  it("rewrites relative CSS import to absolute path", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "./global.css"',
      "./global.css",
      "/project/pages/layout.tsx",
    );
    expect(result).toBe('import "/project/pages/global.css";');
  });

  it("rewrites parent-relative CSS import to absolute path", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "../styles/theme.css"',
      "../styles/theme.css",
      "/project/pages/blog/index.tsx",
    );
    expect(result).toBe('import "/project/pages/styles/theme.css";');
  });

  it("preserves bare specifiers (package imports)", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "@void/md/theme.css"',
      "@void/md/theme.css",
      "/project/pages/layout.tsx",
    );
    expect(result).toBe('import "@void/md/theme.css";');
  });

  it("preserves absolute specifiers", () => {
    const result = rewriteCssImportForVirtualModule(
      'import "/absolute/path/style.css"',
      "/absolute/path/style.css",
      "/project/pages/layout.tsx",
    );
    expect(result).toBe('import "/absolute/path/style.css";');
  });

  it("trims whitespace from non-relative imports", () => {
    const result = rewriteCssImportForVirtualModule(
      '  import "some-lib/styles.css"  ',
      "some-lib/styles.css",
      "/project/pages/layout.tsx",
    );
    expect(result).toBe('import "some-lib/styles.css";');
  });

  it("normalizes backslashes to forward slashes", () => {
    // normalizePath ensures Windows-style paths become valid import specifiers
    const result = rewriteCssImportForVirtualModule(
      'import "./card.css"',
      "./card.css",
      "/project/pages/components/deep/Card.tsx",
    );
    // Should always use forward slashes regardless of OS
    expect(result).not.toContain("\\");
    expect(result).toBe('import "/project/pages/components/deep/card.css";');
  });
});
