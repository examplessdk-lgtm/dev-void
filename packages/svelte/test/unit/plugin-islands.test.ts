import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { islandsPlugin } from "../../src/plugin-islands";

const TMP = join(import.meta.dirname, "__tmp_islands_plugin__");
const PAGES_DIR = join(TMP, "pages");

function writeFile(relativePath: string, content: string): void {
  const full = join(PAGES_DIR, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function setupPlugin() {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0];

  const config = { root: TMP, command: "build" as const, plugins: [] };
  (plugin as any).configResolved(config);

  return {
    async buildStart() {
      await (plugin as any).buildStart.call({});
    },
    loadClientEntry(): string | undefined {
      return (plugin as any).load.handler("\0virtual:void-islands-client");
    },
  };
}

describe("islandsPlugin — layout island import scanning", () => {
  beforeEach(() => {
    mkdirSync(PAGES_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("pre-scans island imports from island layouts into the manifest", async () => {
    writeFile(
      "blog/layout.island.svelte",
      `<script>
import Counter from "../_components/Counter.svelte" with { island: "load" }
</script>
<Counter /><slot />`,
    );
    writeFile("blog/index.island.svelte", `<p>Blog</p>`);
    writeFile(
      "_components/Counter.svelte",
      `<script>let count = $state(0)</script>
<button onclick={() => count++}>{count}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain("pages/_components/Counter");
  });

  it("pre-scans island imports from island pages into the manifest", async () => {
    writeFile(
      "index.island.svelte",
      `<script>
import Toggle from "./Toggle.svelte" with { island: "idle" }
</script>
<Toggle />`,
    );
    writeFile(
      "Toggle.svelte",
      `<script>let on = $state(false)</script>
<button onclick={() => on = !on}>{on}</button>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain("pages/Toggle");
  });

  it("includes island imports from both pages and layouts", async () => {
    writeFile(
      "app/layout.island.svelte",
      `<script>
import Nav from "../_components/Nav.svelte" with { island: "load" }
</script>
<Nav /><slot />`,
    );
    writeFile(
      "app/index.island.svelte",
      `<script>
import Widget from "../_components/Widget.svelte" with { island: "idle" }
</script>
<Widget />`,
    );
    writeFile("_components/Nav.svelte", `<nav>Nav</nav>`);
    writeFile("_components/Widget.svelte", `<div>Widget</div>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain("pages/_components/Nav");
    expect(clientEntry).toContain("pages/_components/Widget");
  });

  it("skips non-island layouts during pre-scan", async () => {
    writeFile(
      "layout.svelte",
      `<script>
import Sidebar from "./Sidebar.svelte" with { island: "load" }
</script>
<slot />`,
    );
    writeFile("index.island.svelte", `<p>Home</p>`);
    writeFile("Sidebar.svelte", `<aside>Sidebar</aside>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).not.toContain("Sidebar");
  });
});
