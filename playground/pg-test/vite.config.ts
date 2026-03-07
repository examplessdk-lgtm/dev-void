import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void-x/react";

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
