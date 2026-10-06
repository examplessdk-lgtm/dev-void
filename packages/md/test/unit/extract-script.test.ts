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

  it('handles single-quoted imports', () => {
    const source = `<script>
import Widget from './Widget.vue' with { island: 'load' }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(1);
    expect(result.islandImports[0]).toEqual({
      name: 'Widget',
      specifier: './Widget.vue',
      strategy: 'load',
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

  it('handles media strategy', () => {
    const source = `<script>
import Sidebar from "./Sidebar.vue" with { island: "media:(min-width: 768px)" }
</script>

# Page`;
    const result = extractScript(source);
    expect(result.islandImports[0].strategy).toBe('media:(min-width: 768px)');
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

  it('extracts island imports with a trailing comma in the attributes', () => {
    const source = `<script>
import Counter from "./Counter.vue" with { island: "load", }
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(1);
    expect(result.islandImports[0]).toEqual({
      name: 'Counter',
      specifier: './Counter.vue',
      strategy: 'load',
    });
    // the island import line is stripped from client code (not leaked as an orphan import)
    expect(result.clientCode).toBeNull();
  });

  it('extracts island imports whose component name starts with $ or _', () => {
    const source = `<script>
import $Counter from "./Counter.vue" with { island: "load" }
</script>

# Hello`;
    const result = extractScript(source);
    expect(result.islandImports).toHaveLength(1);
    expect(result.islandImports[0].name).toBe('$Counter');
    expect(result.clientCode).toBeNull();
  });

  it('keeps commented island imports in client code', () => {
    const result = extractScript(`<script>
// import Fake from "./Fake.vue" with { island: "load" };
import Counter from "./Counter.vue" with { island: "load" };
const ready = true;
</script>`);
    expect(result.islandImports).toEqual([
      { name: 'Counter', specifier: './Counter.vue', strategy: 'load' },
    ]);
    expect(result.clientCode).toContain('// import Fake');
    expect(result.clientCode).toContain('const ready = true;');
  });
});
