import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { glob } from 'tinyglobby';
import { parseRouteFilename } from '../router/parse-filename';
import { resolveNamedLayout } from './layout-resolution';
import type {
  PageDefinition,
  LayoutDefinition,
  NamedLayoutDefinition,
  PageScanResult,
} from './types';

const COMPONENT_EXTENSIONS = ['vue', 'tsx', 'jsx', 'svelte', 'md'];
const SERVER_EXTENSIONS = ['ts', 'tsx', 'js', 'mjs', 'mts'];
const PAGES_EXPORT_RE = /export\s+(?:const|function|async\s+function)\s+(loader|actions?)\b/g;
const REVALIDATE_RE = /export\s+const\s+revalidate\s*=\s*(\d+)\s*;/;
const PRERENDER_RE = /export\s+const\s+prerender\s*=\s*true\s*;/;
const PRERENDER_FALSE_RE = /export\s+const\s+prerender\s*=\s*false\s*;/;
const GET_PRERENDER_PATHS_RE = /export\s+(?:async\s+)?function\s+getPrerenderPaths\b/;
const LAYOUT_STRING_RE = /export\s+const\s+layout\s*=\s*["']([^"']+)["']\s*;?/;
const LAYOUT_FALSE_RE = /export\s+const\s+layout\s*=\s*false\s*;?/;
export const MAX_REVALIDATE = 31536000; // 1 year in seconds

export async function scanPages(
  root: string,
  options?: { output?: 'server' | 'static' },
): Promise<PageScanResult> {
  const pagesDir = join(root, 'pages');
  if (!existsSync(pagesDir)) {
    return { pages: [], layouts: [], namedLayouts: [] };
  }

  const pattern = `**/*.{${COMPONENT_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: pagesDir, absolute: false });

  const pages: PageDefinition[] = [];
  const layouts: LayoutDefinition[] = [];
  const namedLayouts: NamedLayoutDefinition[] = [];

  for (const file of files) {
    const segments = file.split('/');
    // Skip files starting with _ in any segment (except _layouts/)
    if (segments.some((s) => s.startsWith('_') && s !== '_layouts')) {
      continue;
    }

    const ext = extname(file);
    let base = basename(file, ext);

    // Detect island suffix (.island.tsx, .island.vue, etc.)
    let island: boolean | undefined;
    let hasIslandSuffix = false;
    if (base.endsWith('.island')) {
      island = true;
      hasIslandSuffix = true;
      base = base.slice(0, -'.island'.length);
    }
    // .md files are implicitly island (static HTML, zero client JS)
    if (ext === '.md') {
      island = true;
    }

    // Named layout files: _layouts/name.vue, dir/_layouts/name.vue
    const layoutsDirIdx = segments.indexOf('_layouts');
    if (layoutsDirIdx !== -1) {
      // Only files directly inside _layouts/ (not nested deeper)
      if (layoutsDirIdx === segments.length - 2) {
        namedLayouts.push({
          name: base,
          directory: segments.slice(0, layoutsDirIdx).join('/') || '',
          filePath: file,
          island,
        });
      }
      continue;
    }

    // Layout files
    if (base === 'layout') {
      const dir = dirname(file);
      layouts.push({
        directory: dir === '.' ? '' : dir,
        filePath: file,
        island,
      });
      continue;
    }

    // Page files — parse as route
    // parseRouteFilename only strips .ts/.js/.mts/.mjs — convert component
    // extension to .ts so the parser handles it correctly.
    // Strip .island suffix before parsing so route patterns are clean.
    const parseName = hasIslandSuffix
      ? file.replace(`.island${ext}`, '.ts')
      : file.replace(ext, '.ts');
    const route = parseRouteFilename(parseName);
    const componentId =
      file
        .replace(ext, '')
        .replace(/\.island$/, '')
        .replace(/\/index$/, '')
        .replace(/^index$/, '') || 'index';

    // Check for companion .server.ts — server files never have .island suffix
    let serverPath: string | null = null;
    const methods: string[] = [];
    let revalidate: number | undefined;
    let prerender: boolean | undefined;
    let prerenderExplicitlyFalse = false;
    let hasGetPrerenderPaths: boolean | undefined;
    const serverBase = hasIslandSuffix ? file.replace(`.island${ext}`, '') : file.replace(ext, '');
    for (const serverExt of SERVER_EXTENSIONS) {
      const candidate = `${serverBase}.server.${serverExt}`;
      if (existsSync(join(pagesDir, candidate))) {
        serverPath = candidate;
        const content = readFileSync(join(pagesDir, candidate), 'utf-8');
        for (const m of content.matchAll(PAGES_EXPORT_RE)) {
          methods.push(m[1]);
        }
        const revalidateMatch = content.match(REVALIDATE_RE);
        if (revalidateMatch) {
          revalidate = Number(revalidateMatch[1]);
        }
        if (PRERENDER_RE.test(content)) {
          prerender = true;
        }
        if (PRERENDER_FALSE_RE.test(content)) {
          prerenderExplicitlyFalse = true;
        }
        if (GET_PRERENDER_PATHS_RE.test(content)) {
          hasGetPrerenderPaths = true;
        }
        break;
      }
    }

    const isStaticOutput = options?.output === 'static';
    if (isStaticOutput) {
      // Static output: default prerender=true for all pages unless explicitly false.
      // Dynamic pages without getPrerenderPaths stay false (can't prerender without known paths).
      if (!prerenderExplicitlyFalse && prerender !== true) {
        const isDynamic = route.params.length > 0 || route.catchAll;
        if (!isDynamic || hasGetPrerenderPaths) {
          prerender = true;
        }
      }
    } else {
      // Auto-static: island page with no loader and no params → prerender
      if (
        island &&
        !methods.includes('loader') &&
        route.params.length === 0 &&
        !route.catchAll &&
        !prerenderExplicitlyFalse
      ) {
        prerender = true;
      }
    }

    // Prerender → max revalidate (applies to all pages)
    if (prerender && revalidate === undefined) {
      revalidate = MAX_REVALIDATE;
    }

    // Extract frontmatter metadata and layout from .md files, or layout from component files
    let metadata: { title?: string; description?: string } | undefined;
    let layout: string | false | undefined;
    if (ext === '.md') {
      const mdContent = readFileSync(join(pagesDir, file), 'utf-8');
      metadata = extractFrontmatterMeta(mdContent);
      layout = extractFrontmatterLayout(mdContent);
    } else {
      const componentContent = readFileSync(join(pagesDir, file), 'utf-8');
      const layoutStringMatch = componentContent.match(LAYOUT_STRING_RE);
      if (layoutStringMatch) {
        layout = layoutStringMatch[1];
      } else if (LAYOUT_FALSE_RE.test(componentContent)) {
        layout = false;
      }
    }

    pages.push({
      pattern: route.pattern,
      params: route.params,
      catchAll: route.catchAll,
      componentPath: file,
      serverPath,
      methods,
      componentId,
      revalidate,
      prerender,
      hasGetPrerenderPaths,
      island,
      metadata,
      layout,
    });
  }

  // Sort: static before dynamic, catch-all last
  pages.sort((a, b) => {
    if (a.catchAll !== b.catchAll) {
      return a.catchAll ? 1 : -1;
    }
    const aDynamic = a.pattern.includes(':');
    const bDynamic = b.pattern.includes(':');
    if (aDynamic !== bDynamic) {
      return aDynamic ? 1 : -1;
    }
    return a.pattern.localeCompare(b.pattern);
  });

  // Validate: throw when regular pages are under island layouts
  for (const page of pages) {
    if (page.island) {
      continue;
    }
    const dir = dirname(page.componentPath);
    const segments = dir === '.' ? [] : dir.split('/');
    let current = '';
    // Check root layout
    if (layouts.some((l) => l.directory === '' && l.island)) {
      throw new Error(
        `[void] Regular page "${page.componentPath}" is under an island layout — use .island suffix`,
      );
    }
    // Check each directory level
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      if (layouts.some((l) => l.directory === current && l.island)) {
        throw new Error(
          `[void] Regular page "${page.componentPath}" is under an island layout — use .island suffix`,
        );
      }
    }
  }

  // Validate named layout references
  for (const page of pages) {
    if (page.layout === undefined || page.layout === false) {
      continue;
    }
    const isExclusive = page.layout.startsWith('!');
    const name = isExclusive ? page.layout.slice(1) : page.layout;
    // Skip relative path layouts
    if (name.startsWith('.') || name.startsWith('/')) {
      continue;
    }
    if (!resolveNamedLayout(name, page.componentId, namedLayouts)) {
      throw new Error(
        `[void] Page "${page.componentPath}" specifies layout "${page.layout}" but no _layouts/${name}.vue was found in any ancestor directory.`,
      );
    }
  }

  return { pages, layouts, namedLayouts };
}

/** Extract title and description from YAML frontmatter in markdown source. */
function extractFrontmatterMeta(
  source: string,
): { title?: string; description?: string } | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }
  const yaml = match[1];
  const title = yaml
    .match(/^title:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  const description = yaml
    .match(/^description:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  if (!title && !description) {
    return undefined;
  }
  return { title, description };
}

/** Extract layout field from YAML frontmatter in markdown source. */
function extractFrontmatterLayout(source: string): string | false | undefined {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }
  const value = match[1]
    .match(/^layout:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  if (!value) {
    return undefined;
  }
  if (value === 'false') {
    return false;
  }
  return value;
}

export {
  resolveLayoutChain,
  resolveNamedLayout,
  resolveEffectiveLayoutChain,
} from './layout-resolution';
