import { voidSvelte } from "@void-x/svelte";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
