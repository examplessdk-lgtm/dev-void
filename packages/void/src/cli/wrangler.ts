import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InferredBindings } from "../inference/walk";
import type { VoidConfig } from "../config";
import type { WebSocketRouteDefinition } from "../router/websocket";

/** Known-good default compatibility date — bumped when we test against newer runtime versions. */
export const DEFAULT_COMPAT_DATE = "2026-02-12";

const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NODEJS_ALS_FLAG = "nodejs_als";

/** Subset of wrangler config fields we extract. */
export interface WranglerCompat {
  compatibilityDate: string;
  compatibilityFlags?: string[];
}

/**
 * Read compatibility settings from `wrangler.jsonc`/`wrangler.json` and
 * `void.json`, with priority: void.json > wrangler.jsonc > built-in default.
 *
 * Always returns a `compatibilityDate` (falls back to `DEFAULT_COMPAT_DATE`).
 */
export function readWranglerCompat(root: string, config?: VoidConfig): WranglerCompat {
  // 1. Read wrangler.jsonc / wrangler.json
  let raw: string | undefined;
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    try {
      raw = readFileSync(join(root, name), "utf-8");
      break;
    } catch {
      // try next
    }
  }

  let wranglerDate: string | undefined;
  let wranglerFlags: string[] | undefined;
  if (raw) {
    const parsed = parseJsonc(raw);
    if (typeof parsed.compatibility_date === "string") {
      if (!COMPAT_DATE_RE.test(parsed.compatibility_date)) {
        throw new Error(
          `"compatibility_date" in wrangler config must be YYYY-MM-DD format, got "${parsed.compatibility_date}"`,
        );
      }
      wranglerDate = parsed.compatibility_date;
    }
    if (
      Array.isArray(parsed.compatibility_flags) &&
      parsed.compatibility_flags.every((f: unknown) => typeof f === "string")
    ) {
      wranglerFlags = parsed.compatibility_flags;
    }
  }

  // 2. Override with void.json worker fields (higher priority)
  const voidDate = config?.worker?.compatibility_date;
  const voidFlags = config?.worker?.compatibility_flags;

  // 3. Merge: void.json > wrangler.jsonc > default
  const result: WranglerCompat = {
    compatibilityDate: voidDate ?? wranglerDate ?? DEFAULT_COMPAT_DATE,
  };

  const flags = voidFlags ?? wranglerFlags;
  if (flags && flags.length > 0) {
    result.compatibilityFlags = flags;
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
    bindingNames?: { d1?: string; kv?: string; r2?: string };
    websockets?: WebSocketRouteDefinition[];
  },
): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  let created = false;
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        parsed = parseJsonc(readFileSync(p, "utf-8"));
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, "wrangler.jsonc");
    parsed = {};
    created = true;
  }

  let modified = false;

  // D1
  const d1Name = options?.bindingNames?.d1 ?? "DB";
  if (bindings.needsD1) {
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

  // R2
  const r2Name = options?.bindingNames?.r2 ?? "STORAGE";
  if (bindings.needsR2) {
    const existing = (parsed.r2_buckets as { binding: string }[] | undefined) ?? [];
    if (!existing.some((b) => b.binding === r2Name)) {
      parsed.r2_buckets = [...existing, { binding: r2Name, bucket_name: "default" }];
      modified = true;
    }
  }

  if (options?.websockets && options.websockets.length > 0) {
    const existing =
      ((parsed.durable_objects as { bindings?: { name: string; class_name: string }[] } | undefined)
        ?.bindings as { name: string; class_name: string }[] | undefined) ?? [];
    const additions = options.websockets
      .filter((route) => !existing.some((binding) => binding.name === route.bindingName))
      .map((route) => ({ name: route.bindingName, class_name: route.className }));
    if (additions.length > 0) {
      parsed.durable_objects = { bindings: [...existing, ...additions] };
      modified = true;
    }

    if (!Array.isArray(parsed.migrations)) {
      parsed.migrations = [
        {
          tag: "void-ws-v1",
          new_classes: options.websockets.map((route) => route.className),
        },
      ];
      modified = true;
    }
  }

  if (created || modified) {
    writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
  }

  return created || modified;
}

/**
 * Ensure the `nodejs_als` compatibility flag exists in wrangler config.
 * Returns true if the config file was modified.
 */
export function ensureWranglerNodejsAlsFlag(root: string): boolean {
  // Find the wrangler config file
  let configPath: string | undefined;
  let parsed: Record<string, unknown> | undefined;
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(root, name);
    if (existsSync(p)) {
      configPath = p;
      try {
        parsed = parseJsonc(readFileSync(p, "utf-8"));
      } catch {
        // Can't read, skip
      }
      break;
    }
  }

  if (!configPath || !parsed) {
    configPath = join(root, "wrangler.jsonc");
    parsed = {};
  }

  const compatibilityFlags = Array.isArray(parsed.compatibility_flags)
    ? (parsed.compatibility_flags as unknown[])
    : [];
  if (compatibilityFlags.includes(NODEJS_ALS_FLAG)) {
    return false;
  }

  parsed.compatibility_flags = [...compatibilityFlags, NODEJS_ALS_FLAG];
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + "\n");
  return true;
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
