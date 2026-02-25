import { voidReact } from "@void-x/react";
import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
  // stabilize dev server start for tests
  optimizeDeps: { include: ["valibot"] },
});
