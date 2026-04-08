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

/** Extract the plugin's buildStart and load hooks, simulating a minimal Vite lifecycle. */
function setupPlugin() {
  const plugins = islandsPlugin(PAGES_DIR);
  const plugin = plugins[0];

  // Call configResolved with minimal config
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
    // Island layout with an island import — component lives outside the
    // island directory (files under an island layout must use .island suffix)
    writeFile(
      "blog/layout.island.vue",
      `<script setup>
import Counter from "../_components/Counter.vue" with { island: "load" }
</script>
<template><slot /></template>`,
    );
    // Island page under the layout (required by scan rules)
    writeFile(
      "blog/index.island.vue",
      `<script setup></script>
<template><div>Blog</div></template>`,
    );
    // The island component itself (under _ prefix so scanPages ignores it)
    writeFile(
      "_components/Counter.vue",
      `<script setup>
import { ref } from "vue"
const count = ref(0)
</script>
<template><button @click="count++">{{ count }}</button></template>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    // The island manifest should contain the Counter component from the layout
    expect(clientEntry).toContain("pages/_components/Counter");
  });

  it("pre-scans island imports from island pages into the manifest", async () => {
    // Island page with an island import (no layout)
    writeFile(
      "index.island.vue",
      `<script setup>
import Toggle from "./Toggle.vue" with { island: "idle" }
</script>
<template><Toggle /></template>`,
    );
    // The island component
    writeFile(
      "Toggle.vue",
      `<script setup>
import { ref } from "vue"
const on = ref(false)
</script>
<template><button @click="on = !on">{{ on }}</button></template>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain("pages/Toggle");
  });

  it("includes island imports from both pages and layouts", async () => {
    // Island layout with one island import
    writeFile(
      "app/layout.island.vue",
      `<script setup>
import Nav from "../_components/Nav.vue" with { island: "load" }
</script>
<template><Nav /><slot /></template>`,
    );
    // Island page with a different island import
    writeFile(
      "app/index.island.vue",
      `<script setup>
import Widget from "../_components/Widget.vue" with { island: "idle" }
</script>
<template><Widget /></template>`,
    );
    // Both island components (under _ prefix so scanPages ignores them)
    writeFile("_components/Nav.vue", `<template><nav>Nav</nav></template>`);
    writeFile("_components/Widget.vue", `<template><div>Widget</div></template>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    // Both should be in the manifest
    expect(clientEntry).toContain("pages/_components/Nav");
    expect(clientEntry).toContain("pages/_components/Widget");
  });

  it("pre-scans island imports from named island layouts into the manifest", async () => {
    writeFile(
      "_layouts/sidebar.island.vue",
      `<script setup>
import Clock from "../_components/Clock.vue" with { island: "load" }
</script>
<template><Clock /><slot /></template>`,
    );
    writeFile("_components/Clock.vue", `<template><span>12:00</span></template>`);
    writeFile(
      "index.island.vue",
      `<script>
export const layout = "sidebar"
</script>
<template><div>Home</div></template>`,
    );

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    expect(clientEntry).toBeDefined();
    expect(clientEntry).toContain("pages/_components/Clock");
  });

  it("skips non-island layouts during pre-scan", async () => {
    // Regular (non-island) layout — should NOT be scanned
    writeFile(
      "layout.vue",
      `<script setup>
import Sidebar from "./Sidebar.vue" with { island: "load" }
</script>
<template><slot /></template>`,
    );
    // Island page
    writeFile(
      "index.island.vue",
      `<script setup></script>
<template><div>Home</div></template>`,
    );
    writeFile("Sidebar.vue", `<template><aside>Sidebar</aside></template>`);

    const { buildStart, loadClientEntry } = setupPlugin();
    await buildStart();
    const clientEntry = loadClientEntry();

    // Sidebar should NOT be in the manifest since the layout is not an island layout
    expect(clientEntry).not.toContain("Sidebar");
  });
});
