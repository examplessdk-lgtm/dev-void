import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = join(import.meta.dirname, '__tmp_islands_plugin__');
const PAGES_DIR = join(TMP, 'pages');
type HookWithHandler<T> = { handler: T };
type IslandsPluginHooks = {
  configResolved?: (config: {
    root: string;
    command: 'build';
    plugins: ReadonlyArray<unknown>;
  }) => void;
  buildStart?: (() => Promise<void>) | HookWithHandler<() => Promise<void>>;
  load?: ((id: string) => string | undefined) | HookWithHandler<(id: string) => string | undefined>;
};

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin() {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0] as IslandsPluginHooks;

  const config = { root: TMP, command: 'build' as const, plugins: [] };
  plugin.configResolved?.(config);

  return {
    async buildStart() {
      if (typeof plugin.buildStart === 'function') {
        await plugin.buildStart.call({});
      } else {
        await plugin.buildStart?.handler.call({});
      }
    },
    loadClientEntry(): string | undefined {
      if (typeof plugin.load === 'function') {
        return plugin.load('\0virtual:void-islands-client');
      }
      return plugin.load?.handler('\0virtual:void-islands-client');
    },
  };
}

describe('islandsPlugin — layout island import scanning', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('pre-scans island imports from island layouts into the manifest', async () => {
    writeFile(
      'blog/layout.island.svelte',
      `<script>
import Counter from "../_components/Counter.svelte" with { island: "load" }
</script>
<Counter /><slot />`,
    );
    writeFile('blog/index.island.svelte', `<p>Blog</p>`);
    writeFile(
      '_components/Counter.svelte',
      `<script>let count = $state(0)</script>
<button onclick={() => count++}>{count}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Counter');
  });

  it('pre-scans island imports from island pages into the manifest', async () => {
    writeFile(
      'index.island.svelte',
      `<script>
import Toggle from "./Toggle.svelte" with { island: "idle" }
</script>
<Toggle />`,
    );
    writeFile(
      'Toggle.svelte',
      `<script>let on = $state(false)</script>
<button onclick={() => on = !on}>{on}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/Toggle');
  });

  it('pre-scans island imports from named island layouts into the manifest', async () => {
    writeFile(
      '_layouts/sidebar.island.svelte',
      `<script>
import Clock from "../_components/Clock.svelte" with { island: "load" }
</script>
<Clock /><slot />`,
    );
    writeFile('_components/Clock.svelte', `<span>12:00</span>`);
    writeFile(
      'index.island.svelte',
      `<script context="module">
export const layout = "sidebar"
</script>
<p>Home</p>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Clock');
  });

  it('skips non-island layouts during pre-scan', async () => {
    writeFile(
      'layout.svelte',
      `<script>
import Sidebar from "./Sidebar.svelte" with { island: "load" }
</script>
<slot />`,
    );
    writeFile('index.island.svelte', `<p>Home</p>`);
    writeFile('Sidebar.svelte', `<aside>Sidebar</aside>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).not.toContain('Sidebar');
  });
});

describe('islandsPlugin — island style loader', () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('island-style loader is build-only', () => {
    const plugin = islandsPlugin(PAGES_DIR).find(
      (candidate) => candidate.name === 'void-svelte:islands-style',
    );
    expect(plugin?.apply).toBe('build');

    writeFile(
      'Card.island.svelte',
      `<p>Card</p>
<style>p { color: red; }</style>
<style lang="scss">.second { color: blue; }</style>`,
    );
    const load = plugin!.load as HookWithHandler<(id: string) => string>;
    const file = join(PAGES_DIR, 'Card.island.svelte');
    expect(load.handler(`${file}?island-style&index=1&lang.css`)).toBe('.second { color: blue; }');
  });
});
