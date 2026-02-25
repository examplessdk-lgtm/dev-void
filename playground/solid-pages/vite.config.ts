import { voidSolid } from "@void-x/solid";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin(), voidSolid()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
