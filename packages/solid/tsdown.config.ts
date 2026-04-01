import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/plugin.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: [
    "solid-js",
    "solid-js/web",
    "solid-js/store",
    "vite",
    "void",
    "void/*",
    "vite-plugin-solid",
  ],
});
