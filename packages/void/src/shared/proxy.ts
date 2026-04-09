// Base URLs for the Void proxy. Imported by the Vite plugin (index.ts) to set
// __VOID_PROXY_URL bindings during `vite dev`, and by the prerender runner
// (prerender.ts) to set the same binding when booting Miniflare during
// `vite build`. Dev and prerender MUST produce the same value; previously
// each site inlined its own copy of these strings, which is a silent
// misrouting hazard if the proxy hostname ever changes.
//
// Not the same as the constants in runtime/ai.ts — those have a trailing
// "/ai" path segment and live in the worker runtime bundle.
export const DEFAULT_PROXY_URL = 'https://proxy.void.cloud';
export const STAGING_PROXY_URL = 'https://proxy.staging.void.cloud';
