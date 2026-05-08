import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'pathe';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const TMP = join(import.meta.dirname, '__tmp_islands_plugin__');
const PAGES_DIR = join(TMP, 'pages');
type HookWithHandler<T> = { handler: T };
type IslandsPluginHooks = {
  configResolved?: (config: { root: string; command: 'build'; plugins: Array<unknown> }) => void;
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
      'blog/layout.island.tsx',
      `import Counter from "../_components/Counter" with { island: "load" }
export default function Layout({ children }) { return <div><Counter />{children}</div>; }`,
    );
    writeFile(
      'blog/index.island.tsx',
      `export default function Blog() { return <div>Blog</div>; }`,
    );
    writeFile(
      '_components/Counter.tsx',
      `export default function Counter() { return <button>0</button>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Counter');
  });

  it('pre-scans island imports from island pages into the manifest', async () => {
    writeFile(
      'index.island.tsx',
      `import Toggle from "./Toggle" with { island: "idle" }
export default function Home() { return <Toggle />; }`,
    );
    writeFile('Toggle.tsx', `export default function Toggle() { return <button>off</button>; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/Toggle');
  });

  it('includes island imports from both pages and layouts', async () => {
    writeFile(
      'app/layout.island.tsx',
      `import Nav from "../_components/Nav" with { island: "load" }
export default function Layout({ children }) { return <div><Nav />{children}</div>; }`,
    );
    writeFile(
      'app/index.island.tsx',
      `import Widget from "../_components/Widget" with { island: "idle" }
export default function Index() { return <Widget />; }`,
    );
    writeFile('_components/Nav.tsx', `export default function Nav() { return <nav />; }`);
    writeFile('_components/Widget.tsx', `export default function Widget() { return <div />; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Nav');
    expect(clientEntry).toContain('pages/_components/Widget');
  });

  it('pre-scans island imports from named island layouts into the manifest', async () => {
    writeFile(
      '_layouts/sidebar.island.tsx',
      `import Clock from "../_components/Clock" with { island: "load" }
export default function Sidebar({ children }) { return <div><Clock />{children}</div>; }`,
    );
    writeFile(
      '_components/Clock.tsx',
      `export default function Clock() { return <span>12:00</span>; }`,
    );
    writeFile(
      'index.island.tsx',
      `export const layout = "sidebar"
export default function Home() { return <div>Home</div>; }`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain('pages/_components/Clock');
  });

  it('skips non-island layouts during pre-scan', async () => {
    writeFile(
      'layout.tsx',
      `import Sidebar from "./Sidebar" with { island: "load" }
export default function Layout({ children }) { return <div>{children}</div>; }`,
    );
    writeFile('index.island.tsx', `export default function Home() { return <div>Home</div>; }`);
    writeFile('Sidebar.tsx', `export default function Sidebar() { return <aside />; }`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).not.toContain('Sidebar');
  });
});
