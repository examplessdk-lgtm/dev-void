import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts", "src/runtime/index.ts", "src/runtime/prefetch.ts"],
  format: "esm",
  dts: true,
  clean: true,
  external: [
    "react",
    "react/jsx-runtime",
    "react-dom",
    "react-dom/server",
    "react-dom/client",
    "vite",
    "void",
    "void/*",
    "@vitejs/plugin-react",
  ],
});
