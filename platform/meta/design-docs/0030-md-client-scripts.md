# Markdown Client Scripts

**Date:** 2026-02-26
**Status:** Design

---

## Summary

Enable client-side code execution in markdown pages via the existing `<script>` block. Today, `<script>` in `.md` files only supports island component imports (stripped at build time). This extends it so non-island code in the same block is bundled and executed in the browser when the page loads.

No new syntax — the `with { island }` import attribute already distinguishes island imports from regular code. Everything without that attribute becomes a client module.

---

## User-Facing API

```md
<script>
import Counter from "./Counter.vue" with { island: "visible" }
import { format } from "date-fns"

document.querySelector('.date').textContent = format(new Date(), 'PPP')
</script>

# My Post

<Counter />

Published: <span class="date"></span>
```

- Island imports (`with { island }`) → existing SSR + hydration pipeline (unchanged)
- Regular imports + statements → bundled as a client module, executed on page load
- Both coexist in a single `<script>` block

---

## Architecture

### Script Splitting

`extractScript()` already returns the full script content and island imports separately. The change: after extraction, strip island import lines from the script to produce `clientCode`. If `clientCode` is non-trivial (not just whitespace/comments), it's the page's client script.

### Virtual Modules

Each `.md` page with client code gets a virtual module: `virtual:void-md-script:{componentId}`

The md plugin:

1. In `buildStart()`, scans all `.md` files (already happens via `scanMdPages`), stores client code in `Map<componentId, code>`
2. Handles `resolveId`/`load` for these virtual modules
3. Exposes the map via its plugin `api` property

### Client Build Integration

The islands plugin's `generateIslandClientEntry()` is extended to include md client scripts. After the existing island hydration code:

```js
// Existing: hydrate [data-island] elements
document.querySelectorAll('[data-island]').forEach(/* ... */);

// New: md client scripts (code-split via dynamic import)
const mdScriptId = document.getElementById('app')?.getAttribute('data-md-script');
const mdScripts = {
  'pages/my-post': () => import('virtual:void-md-script:pages/my-post'),
};
if (mdScriptId && mdScripts[mdScriptId]) mdScripts[mdScriptId]();
```

Dynamic imports → Vite code-splits each page's script into its own chunk. Only the current page's script is loaded at runtime.

### Renderer Integration

The island renderer (`generateIslandRenderer`) adds `data-md-script="{componentId}"` to the `<div id="app">` element when the page component has a client script. The client entry reads this attribute to determine which script to execute.

### Dev Mode

Virtual modules served on-demand by Vite. Same `data-md-script` + dynamic import pattern. HMR via Vite's module graph invalidation when the `.md` source changes.

---

## Implementation Plan

### Step 1: Extend `extractScript()` (md plugin)

**File:** `framework/packages/md/src/extract-script.ts`

Return `clientCode` alongside existing fields: strip island import lines from the script content. The caller gets `{ script, body, islandImports, clientCode }`.

### Step 2: Store client scripts in md plugin state

**File:** `framework/packages/md/src/index.ts`

- Add a `clientScripts: Map<string, string>` at the plugin level
- In `scanMdPages()` (called during `buildStart`), populate the map when `clientCode` is non-empty
- In the `transform` hook, also populate/update the map
- Add `resolveId`/`load` hooks for `virtual:void-md-script:*`
- Expose the map via the plugin's `api` property

### Step 3: Extend islands client entry

**File:** `framework/packages/vue/src/plugin-islands.ts`

- In `generateIslandClientEntry()`, find the md plugin via the Vite plugin array, read its `api.getClientScripts()`
- Append URL-matched dynamic imports to the generated entry code
- In `generateIslandRenderer()`, add `data-md-script` attribute to the app div when the component has a client script

### Step 4: Handle edge case — client script without islands

A `.md` page might have client code but no island imports. Today such a page has zero client JS. After this change, the islands client entry must still be included for the md script to execute. Ensure the renderer includes the client entry script tag even when there are no islands but there is a client script.

---

## Files Changed

| File                                           | Change                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `framework/packages/md/src/extract-script.ts`  | Return `clientCode` (script minus island imports)                            |
| `framework/packages/md/src/index.ts`           | Store client scripts, virtual module resolveId/load, expose API              |
| `framework/packages/vue/src/plugin-islands.ts` | Extend client entry + renderer for md scripts                                |
| `framework/packages/void/src/pages/types.ts`   | Add `hasClientScript?: boolean` to `PageDefinition` (if needed for renderer) |
| `framework/packages/void/src/pages/scan.ts`    | Detect client scripts during page scan (if needed)                           |
