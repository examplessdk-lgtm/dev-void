import { describe, it, expect } from "vitest";

import { FRAMEWORK_PRESETS } from "../../src/cli/preset";

describe("FRAMEWORK_PRESETS", () => {
  it("has preset for sveltekit", () => {
    const preset = FRAMEWORK_PRESETS.sveltekit;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe("vite build");
    expect(preset.workerDir).toBe(".svelte-kit/cloudflare");
    expect(preset.workerMain).toBe("_worker.js");
    expect(preset.assetsDir).toBe(".svelte-kit/cloudflare");
  });

  it("has preset for nuxt", () => {
    const preset = FRAMEWORK_PRESETS.nuxt;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe("nuxt build");
    expect(preset.workerDir).toBe(".output/server");
    expect(preset.workerMain).toBe("index.mjs");
    expect(preset.assetsDir).toBe(".output/public");
  });

  it("has preset for astro", () => {
    const preset = FRAMEWORK_PRESETS.astro;
    expect(preset).toBeDefined();
    expect(preset.buildCommand).toBe("astro build");
    expect(preset.workerDir).toBe("dist/_worker.js");
    expect(preset.workerMain).toBe("index.js");
    expect(preset.assetsDir).toBe("dist");
  });

  it("all presets have required fields", () => {
    for (const preset of Object.values(FRAMEWORK_PRESETS)) {
      expect(preset.buildCommand).toBeTruthy();
      expect(preset.workerDir).toBeTruthy();
      expect(preset.workerMain).toBeTruthy();
      expect(preset.assetsDir).toBeTruthy();
    }
  });
});
