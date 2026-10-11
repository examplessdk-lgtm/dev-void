import { describe, expect, it } from 'vite-plus/test';
import { extractScript } from '../../src/extract-script.ts';

describe('extractScript', () => {
  it('returns null script when no <script> block', () => {
    const result = extractScript('# Hello\n\nWorld');
    expect(result.script).toBeNull();
    expect(result.body).toBe('# Hello\n\nWorld');
    expect(result.islandImports).toEqual([]);
    expect(result.clientCode).toBeNull();
  });

  it('extracts <script> block and returns body without it', () => {
    const source = `<script>
import Foo from "./Foo.vue" with { island: "load" }
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.script).toBe('import Foo from "./Foo.vue" with { island: "load" }');
    expect(result.body.trim()).toBe('# Hello');
  });

  it('parses island imports with correct name/specifier/strategy', () => {
    const source = `<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
import CodePlayground from "../components/CodePlayground.vue" with { island: "idle" }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(2);
    expect(result.islandImports[0]).toEqual({
      name: 'Counter',
      specifier: '../components/Counter.vue',
      strategy: 'visible',
    });
    expect(result.islandImports[1]).toEqual({
      name: 'CodePlayground',
      specifier: '../components/CodePlayground.vue',
      strategy: 'idle',
    });
  });

  it('handles <script> before frontmatter', () => {
    const source = `<script>
import A from "./A.vue" with { island: "load" }
</script>

---
title: Test
---

# Hello`;
    const result = extractScript(source);
    expect(result.script).toContain('import A');
    expect(result.body).toContain('---');
    expect(result.body).toContain('# Hello');
  });

  it('returns clientCode as null when script has only island imports', () => {
    const source = `<script>
import Counter from "./Counter.vue" with { island: "visible" }
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.clientCode).toBeNull();
  });

  it('extracts non-island code as clientCode', () => {
    const source = `<script>
import Counter from "./Counter.vue" with { island: "visible" }
import { format } from "date-fns"

console.log("hello")
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.clientCode).toBe(`import { format } from "date-fns"\n\nconsole.log("hello")`);
  });

  it('returns entire script as clientCode when no island imports', () => {
    const source = `<script>
console.log("client only")
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.clientCode).toBe(`console.log("client only")`);
    expect(result.islandImports).toEqual([]);
  });

  it('preserves non-island imports in clientCode alongside statements', () => {
    const source = `<script>
import Counter from "./Counter.vue" with { island: "load" }
import { ref } from "vue"

const count = ref(0)
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.clientCode).toBe(`import { ref } from "vue"\n\nconst count = ref(0)`);
  });
});
