import { cpSync } from "node:fs";
import { defineConfig } from "tsdown";

const WORKERS_TYPES_REFERENCE = '/// <reference types="@cloudflare/workers-types" />';

function stripUseAsmPlugin() {
  return {
    name: "void:strip-use-asm",
    // es-module-lexer/js (asm.js variant) contains "use asm" which triggers a
    // harmless but noisy V8 warning on Node 24+. Strip it from the bundle.
    renderChunk(code: string) {
      if (code.includes('"use asm"')) {
        return code.replace('"use asm"', "");
      }
    },
  };
}

function injectWorkersTypesReferencePlugin() {
  return {
    name: "void:inject-workers-types-reference",
    // tsdown's declaration emit currently drops source-level triple-slash references.
    // Our public handler types use Cloudflare global types (D1Database, KVNamespace, etc.),
    // so we inject the reference into the emitted .d.mts to keep consumer DX zero-config.
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      for (const output of Object.values(bundle)) {
        // Only patch the public handler declaration entrypoint.
        if (output.fileName !== "runtime/handler.d.mts") continue;

        if (output.type === "asset") {
          const source = String(output.source ?? "");
          if (!source.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.source = `${WORKERS_TYPES_REFERENCE}\n${source}`;
          }
          continue;
        }

        if (output.type === "chunk") {
          const code = String(output.code ?? "");
          if (!code.startsWith(WORKERS_TYPES_REFERENCE)) {
            output.code = `${WORKERS_TYPES_REFERENCE}\n${code}`;
          }
        }
      }
    },
  };
}

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime/handler.ts",
    "src/runtime/response.ts",
    "src/runtime/validator.ts",
    "src/routes-stub.ts",
    "src/runtime/client.ts",
    "src/runtime/fetch.ts",
    "src/runtime/fetch-stream.ts",
    "src/runtime/auth.ts",
    "src/runtime/auth-client.ts",
    "src/auth/session.ts",
    "src/auth/password.ts",
    "src/auth/schema.ts",
    "src/runtime/env.ts",
    "src/runtime/db.ts",
    "src/runtime/schema-d1.ts",
    "src/runtime/schema-pg.ts",
    "src/runtime/kv.ts",
    "src/runtime/queues.ts",
    "src/runtime/storage.ts",
    "src/runtime/isr.ts",
    "src/runtime/ai.ts",
    "src/runtime/remote/index.ts",
    "src/runtime/remote/binding-handler.ts",
    "src/runtime/migration-handler.ts",
    "src/pages/index.ts",
    "src/pages/protocol.ts",
    "src/pages/head.ts",
    "src/pages/head-client.ts",
    "src/pages/prefetch.ts",
    "src/pages/client.ts",
    "src/pages/islands-plugin.ts",
    "src/runtime/vue.ts",
    "src/runtime/react.ts",
    "src/runtime/svelte.ts",
    "src/runtime/solid.ts",
    "src/cli/cli.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  onSuccess() {
    cpSync("src/css", "dist/css", { recursive: true });
  },
  plugins: [stripUseAsmPlugin(), injectWorkersTypesReferencePlugin()],
  external: [
    "vite",
    "@cloudflare/vite-plugin",
    "better-sqlite3",
    "cloudflare:workers",
    "@void-x/vue",
    "@void-x/react",
    "@void-x/svelte",
    "@void-x/solid",
    "@napi-rs/keyring",
    "undici", // ofetch imports this in types
  ],
  inlineOnly: [
    "fdir",
    "picomatch",
    "tinyglobby",
    "estree-walker",
    "es-module-lexer",
    "@clack/prompts",
    "@clack/core",
    "sisteransi",
    "picocolors",
    "ofetch",
  ],
});
