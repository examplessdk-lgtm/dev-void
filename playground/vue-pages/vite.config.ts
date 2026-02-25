import { voidVue } from "@void-x/vue";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin(), voidVue()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
