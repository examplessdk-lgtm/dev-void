import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { voidPlugin } from "void";

export default defineConfig({
  plugins: [
    // voidPlugin wraps @cloudflare/vite-plugin — must come before tanstackStart
    voidPlugin(),
    tanstackStart(),
    react(),
  ],
});
