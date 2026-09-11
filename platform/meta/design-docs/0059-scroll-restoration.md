---
title: Scroll Position Restoration
status: proposed
created: 2026-03-10
---

# Scroll Position Restoration

## Problem

The Void pages router (`framework/packages/void/src/pages/client.ts`) does not save or restore scroll position during client-side navigation. Back/forward navigation scrolls to top, which is incorrect UX.

Current behavior:

- `router.visit()` calls `window.scrollTo(0, 0)` unless `preserveScroll: true`
- Popstate handler calls `router.visit()` with `preserveState: true` but not `preserveScroll: true`, so back/forward always scrolls to top
- `history.pushState({}, "", pageData.url)` passes an empty state object — no scroll position is saved
- Hash fragments in URLs are lost during navigation

## Approach

Use `history.state` to store `{scrollX, scrollY}` per history entry. This is the same approach Inertia.js uses. No sessionStorage needed — Void pages fetch fresh data on reload anyway, so cross-reload scroll restoration adds little value.

All changes live in `client.ts`. No adapter changes. No `<Link>` component changes.

## Design

### 1. Manual scroll restoration

In `start()`, set `history.scrollRestoration = "manual"` to prevent the browser's built-in restoration from fighting the custom logic. Seed the initial history entry with current scroll position via `replaceState`.

### 2. Save scroll before navigating away

Before every `pushState` in `visit()`, save the current scroll into the outgoing history entry via `replaceState`:

```ts
history.replaceState({ scrollX: window.scrollX, scrollY: window.scrollY }, '');
history.pushState({}, '', finalUrl);
```

### 3. Popstate reads saved position

The popstate handler reads `event.state` and passes the saved scroll position to `visit()` via an internal `_scrollPosition` option:

```ts
window.addEventListener('popstate', (e) => {
  const scrollPosition = e.state ? { x: e.state.scrollX ?? 0, y: e.state.scrollY ?? 0 } : null;
  router.visit(window.location.pathname + window.location.search + window.location.hash, {
    preserveState: true,
    _scrollPosition: scrollPosition,
  });
});
```

`_scrollPosition` is an internal field on `VisitOptions` (prefixed to signal it's not public API).

### 4. Hash extraction and preservation

At the top of `visit()`, split the hash from the URL before fetching:

```ts
const hashIndex = url.indexOf('#');
const hash = hashIndex !== -1 ? url.slice(hashIndex) : '';
const fetchUrl = hashIndex !== -1 ? url.slice(0, hashIndex) : url;
```

The hash is appended to the `pushState` URL: `pageData.url + hash`.

### 5. Same-page hash navigation (short-circuit)

If path+search match the current page and there's a hash, skip the server fetch entirely:

```ts
const current = window.location.pathname + window.location.search;
if (fetchUrl === current && hash && !options.method) {
  history.replaceState({ scrollX: window.scrollX, scrollY: window.scrollY }, '');
  history.pushState({}, '', fetchUrl + hash);
  const el = document.getElementById(hash.slice(1));
  if (el) el.scrollIntoView();
  else window.scrollTo(0, 0);
  return;
}
```

### 6. Post-navigation scroll priority

After `applyUpdate()`, scroll based on priority:

1. **`preserveScroll: true`** — do nothing (existing behavior)
2. **Popstate with saved position** — restore `{x, y}`
3. **URL has hash** — `document.getElementById(hash.slice(1))?.scrollIntoView()`
4. **Otherwise** — `window.scrollTo(0, 0)` (forward navigation)

### 7. Scroll timing with view transitions

Restructure the post-update flow so scroll happens after the DOM is actually updated:

```ts
const doScroll = () => {
  /* priority logic from §6 */
};

if (useTransition && document.startViewTransition) {
  const transition = document.startViewTransition(() =>
    adapter.applyUpdate(pageData, comp, layouts),
  );
  transition.updateCallbackDone.then(doScroll);
} else {
  adapter.applyUpdate(pageData, comp, layouts);
  requestAnimationFrame(doScroll);
}
```

`applyClientHead()` and `pushState` move above this block (they don't depend on DOM paint).

## Files touched

| File                           | Change                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `client.ts` — `VisitOptions`   | Add `_scrollPosition?: { x: number; y: number }`                                                                    |
| `client.ts` — `start()`        | Set `history.scrollRestoration = "manual"`, seed initial state                                                      |
| `client.ts` — popstate handler | Read `event.state`, pass `_scrollPosition`, include hash in URL                                                     |
| `client.ts` — `visit()`        | Hash extraction, same-page short-circuit, save scroll before pushState, post-update scroll logic with proper timing |
