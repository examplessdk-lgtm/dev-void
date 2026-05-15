export interface PageDefinition {
  /** URL pattern, e.g. "/users/:id" */
  pattern: string;
  /** Route params, e.g. ["id"] */
  params: Array<string>;
  /** Whether this is a catch-all route */
  catchAll: boolean;
  /** Component file relative path, e.g. "users/[id].vue" */
  componentPath: string;
  /** Server handler file relative path, e.g. "users/[id].server.ts" */
  serverPath: string | null;
  /** HTTP methods exported by server handler */
  methods: Array<string>;
  /** Component ID used in page object, e.g. "users/[id]" */
  componentId: string;
  /** Edge caching revalidate TTL in seconds, from .server.ts export */
  revalidate?: number;
  /** Whether `export const prerender = true` is set in server handler */
  prerender?: boolean;
  /** Whether `export function getPrerenderPaths` is defined in server handler */
  hasGetPrerenderPaths?: boolean;
  /** Whether this is an island page (.island.tsx/.island.vue) */
  island?: boolean;
  /** Frontmatter metadata extracted from .md files (title, description) */
  metadata?: { title?: string; description?: string };
  /** Named layout selection: "name", "!name", false, or relative path */
  layout?: string | false;
}

export interface LayoutDefinition {
  /** Directory path relative to pages/, e.g. "" (root) or "users" */
  directory: string;
  /** Layout file relative path, e.g. "layout.vue" or "users/layout.vue" */
  filePath: string;
  /** Whether this is an island layout (layout.island.tsx/.island.vue) */
  island?: boolean;
}

export interface NamedLayoutDefinition {
  /** Layout name, e.g. "home", "post" */
  name: string;
  /** Directory containing _layouts/, e.g. "" (root) or "guide" */
  directory: string;
  /** File path relative to pages/, e.g. "_layouts/home.vue" */
  filePath: string;
  /** Whether this is an island layout */
  island?: boolean;
}

export interface PageScanResult {
  pages: Array<PageDefinition>;
  layouts: Array<LayoutDefinition>;
  namedLayouts: Array<NamedLayoutDefinition>;
}

export interface DevCssAsset {
  /** Vite client URL used to request the CSS module. */
  url: string;
  /** Vite dev style id used by the client to adopt/update SSR-inlined styles. */
  id?: string;
  /** CSS bytes returned by Vite's client environment transform with ?inline. */
  css: string;
}
