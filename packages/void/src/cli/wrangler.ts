import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { InferredBindings } from "../inference/walk";

/** Subset of wrangler config fields we extract. */
export interface WranglerCompat {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
}

/**
 * Read `wrangler.jsonc` or `wrangler.json` from the project root and extract
 * compatibility settings. Returns an empty object if no file is found.
 */
export function readWranglerCompat(root: string): WranglerCompat {
  let raw: string | undefined;
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    try {
      raw = readFileSync(join(root, name), "utf-8");
      break;
    } catch {
      // try next
    }
  }
  if (!raw) return {};

  const parsed = parseJsonc(raw);
  const result: WranglerCompat = {};

  if (typeof parsed.compatibility_date === "string") {
    result.compatibilityDate = parsed.compatibility_date;
  }
  if (
    Array.isArray(parsed.compatibility_flags) &&
    parsed.compatibility_flags.every((f: unknown) => typeof f === "string")
  ) {
    result.compatibilityFlags = parsed.compatibility_flags;
  }

  return result;
}

/**
 * Sync inferred/configured bindings into the project's wrangler.jsonc for local dev.
 * Only adds bindings that are missing — existing bindings are preserved.
 * Returns true if the file was modified.
 */
export function syncWranglerBindings(
  root: string,
  bindings: InferredBindings,
  options?: {
    auth?: boolean;
    bindingNames?: { d1?: string; kv?: string; r2?: string };
  },
): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let raw: string | undefined;
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        raw = readFileSync(p, "utf-8");
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !raw) return false;

  const parsed = parseJsonc(raw);
  let modified = false;

  // D1
  const d1Name = options?.bindingNames?.d1 ?? "DB";
  if (bindings.needsD1 || options?.auth) {
    const existing = (parsed.d1_databases as { binding: string }[] | undefined) ?? [];
    if (!existing.some((b) => b.binding === d1Name)) {
      parsed.d1_databases = [
        ...existing,
        { binding: d1Name, database_name: "default", database_id: "local" },
      ];
      modified = true;
    }
  }

  // KV
  const kvName = options?.bindingNames?.kv ?? "KV";
  if (bindings.needsKV) {
    const existing = (parsed.kv_namespaces as { binding: string }[] | undefined) ?? [];
    if (!existing.some((b) => b.binding === kvName)) {
      parsed.kv_namespaces = [...existing, { binding: kvName, id: "local" }];
      modified = true;
    }
  }

  // AUTH_KV for auth sessions
  if (options?.auth) {
    const existing = (parsed.kv_namespaces as { binding: string }[] | undefined) ?? [];
    if (!existing.some((b) => b.binding === "AUTH_KV")) {
      parsed.kv_namespaces = [...existing, { binding: "AUTH_KV", id: "auth-local" }];
      modified = true;
    }
  }

  // R2
  const r2Name = options?.bindingNames?.r2 ?? "STORAGE";
  if (bindings.needsR2) {
    const existing = (parsed.r2_buckets as { binding: string }[] | undefined) ?? [];
    if (!existing.some((b) => b.binding === r2Name)) {
      parsed.r2_buckets = [...existing, { binding: r2Name, bucket_name: "default" }];
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(configPath, JSON.stringify(parsed, null, "\t") + "\n");
  }

  return modified;
}

/**
 * Minimal JSONC parser — strips single-line (`//`) and multi-line comments
 * before parsing as JSON. Handles comments inside strings correctly.
 */
function parseJsonc(text: string): Record<string, unknown> {
  let result = "";
  let i = 0;
  while (i < text.length) {
    // String literal — copy verbatim
    if (text[i] === '"') {
      const start = i;
      i++; // skip opening quote
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      result += text.slice(start, i);
      continue;
    }
    // Single-line comment
    if (text[i] === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    // Multi-line comment
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }
    result += text[i];
    i++;
  }
  return JSON.parse(result);
}
