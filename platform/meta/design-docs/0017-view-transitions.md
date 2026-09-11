# View Transitions for Pages Mode

**Status:** Implemented

## Summary

Add browser-native [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) support to `@void/vue` Pages mode client-side navigation. Wraps the DOM mutation inside `document.startViewTransition()` so the browser cross-fades between old and new page snapshots automatically.

## Decision Record

- **Opt-in only** — no transitions by default, zero behavior change for existing users.
- **Router-level integration** — wrap the synchronous state swap inside `router.visit()` rather than at the Link component or Vue render layer. All navigation types (Link clicks, programmatic calls, popstate) go through this single point.
- **Plugin config + per-link/per-call override** — global toggle via `voidVue({ viewTransitions: true })`, overridable per-`<Link>` or per-`router.visit()` call.
- **Includes popstate** — back/forward navigations also get transitions when the feature is enabled.
- **No lifecycle hooks for now** — users customize via CSS (`view-transition-name`, `::view-transition-old/new`). Hooks can be added later if demanded.
- **Progressive enhancement** — feature-detected via `document.startViewTransition`. Unsupported browsers fall through to instant update.

## API Surface

### Plugin Config

```ts
export type VoidVueOptions = {
  vue?: Parameters<typeof vue>[0];
  viewTransitions?: boolean; // default: false
};
```

### Link Component

```vue
<!-- Override globally enabled transitions for this link -->
<Link href="/about" :view-transition="false">About</Link>

<!-- Enable for just this link even if globally disabled -->
<Link href="/about" view-transition>About</Link>
```

### Programmatic Navigation

```ts
router.visit('/about', { viewTransition: true });
```

Resolution order: **per-call option > per-link prop > global config > false**.

## Implementation

### Core Change: `router.visit()`

After the fetch completes and component/layouts are resolved asynchronously, wrap the synchronous DOM mutation in `startViewTransition()`:

```ts
const applyUpdate = () => {
  Object.assign(shared, pageData.shared || {});
  for (const key of Object.keys(errors)) delete errors[key];
  Object.assign(errors, pageData.errors || {});
  currentProps.value = pageData.props;
  currentLayouts.value = layouts;
  currentComponent.value = comp;
};

const useTransition = options.viewTransition ?? VIEW_TRANSITIONS_ENABLED;

if (useTransition && document.startViewTransition) {
  document.startViewTransition(() => {
    applyUpdate();
    return nextTick();
  });
} else {
  applyUpdate();
}
```

Key details:

- `VIEW_TRANSITIONS_ENABLED` is a const baked in by codegen.
- The callback returns `nextTick()` so the browser waits for Vue to flush DOM before snapshotting the new state.
- Async work (fetch, component loading) happens **before** `startViewTransition()` — only the synchronous state swap is inside the transition callback.

### Config Flow

`voidVue({ viewTransitions })` → `pagesPlugin(pagesDir, { viewTransitions })` → codegen emits `const VIEW_TRANSITIONS_ENABLED = ${!!viewTransitions};`

### Link Component

Add `viewTransition` prop (Boolean, default `undefined`), pass through to `router.visit()`.

## Files Changed

1. **`packages/vue/src/index.ts`** — add `viewTransitions` to options, pass to `pagesPlugin()`
2. **`packages/vue/src/plugin-pages.ts`** — accept option, thread into codegen; refactor `router.visit()` to wrap mutations in `startViewTransition()` when enabled
3. **`packages/vue/src/runtime/link.ts`** — add `viewTransition` prop, pass to `router.visit()`

## Testing

- Existing `vue-pages-client.test.ts` tests pass unchanged (feature off by default).
- Add test with `viewTransitions: true` verifying navigation still works (transition is progressive enhancement — DOM update is the same, just wrapped).
- No need to test actual animation (browser internals).

## Documentation

- Add "View Transitions" section to Pages navigation docs showing config, per-link override, and CSS customization example.
