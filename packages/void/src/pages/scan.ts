import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename, extname } from 'pathslash';
import { glob } from 'tinyglobby';
import { parseSync } from 'vite';
import { readProjectPaths, type ProjectPaths } from '../project-paths.ts';
import { parseRouteFilename } from '../router/parse-filename.ts';
import {
  isIdentifier,
  isLiteral,
  type AstExportNamedDeclaration,
  type AstFunctionDeclaration,
  type AstNode,
  type AstProgram,
  type AstVariableDeclaration,
} from '../shared/ast.ts';
import { resolveNamedLayout } from './layout-resolution.ts';
import type {
  ExplicitBoolean,
  PageDefinition,
  PageRenderMode,
  PrerenderMode,
  LayoutDefinition,
  NamedLayoutDefinition,
  PageScanResult,
  SsrMode,
} from './types.ts';

const COMPONENT_EXTENSIONS = ['vue', 'tsx', 'jsx', 'svelte', 'md'];
const SERVER_EXTENSIONS = ['ts', 'tsx', 'js', 'mjs', 'mts'];
const PAGE_METHODS = new Set(['loader', 'action', 'actions']);
const LAYOUT_STRING_RE = /export\s+const\s+layout\s*=\s*["']([^"']+)["']\s*;?/;
const LAYOUT_FALSE_RE = /export\s+const\s+layout\s*=\s*false\s*;?/;
export const MAX_REVALIDATE = 31536000; // 1 year in seconds

type PageRenderingSource = {
  componentPath: string;
  island?: boolean;
  ssr?: ExplicitBoolean;
  prerender?: ExplicitBoolean;
  methods: Array<string>;
  params: Array<string>;
  catchAll: boolean;
  hasGetPrerenderPaths?: boolean;
};

type PageScanOptions = { output?: 'server' | 'static'; paths?: ProjectPaths; pagesDir?: string };

type ResolvedPageRendering = {
  ssrMode: SsrMode;
  prerenderMode: PrerenderMode;
  renderMode: PageRenderMode;
  shouldPrerender: boolean;
};

type PageServerMetadata = {
  methods: Array<string>;
  revalidate?: number;
  prerender?: ExplicitBoolean;
  ssr?: ExplicitBoolean;
  hasGetPrerenderPaths?: boolean;
};

const TRANSPARENT_EXPRESSION_TYPES = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function asAstNode(value: unknown): AstNode | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  ) {
    return value as AstNode;
  }
  return undefined;
}

function unwrapTransparentExpression(node: AstNode | null | undefined): AstNode | undefined {
  let current = node ?? undefined;
  while (current && TRANSPARENT_EXPRESSION_TYPES.has(current.type)) {
    current = asAstNode(current.expression);
  }
  return current;
}

function extractPageServerMetadata(filename: string, code: string): PageServerMetadata {
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filename, code);
  } catch {
    return { methods: [] };
  }

  const metadata: PageServerMetadata = { methods: [] };
  const methodNames = new Set<string>();

  const recordExport = (name: string, init?: AstNode): void => {
    if (PAGE_METHODS.has(name)) {
      methodNames.add(name);
      return;
    }
    if (name === 'getPrerenderPaths') {
      metadata.hasGetPrerenderPaths = true;
      return;
    }
    const literal = unwrapTransparentExpression(init);
    if (!isLiteral(literal)) {
      return;
    }
    if (
      name === 'revalidate' &&
      typeof literal.value === 'number' &&
      Number.isInteger(literal.value) &&
      literal.value >= 0
    ) {
      metadata.revalidate = literal.value;
    } else if (name === 'prerender' && typeof literal.value === 'boolean') {
      metadata.prerender = literal.value;
    } else if (name === 'ssr' && typeof literal.value === 'boolean') {
      metadata.ssr = literal.value;
    }
  };

  const program = parsed.program as unknown as AstProgram;
  for (const node of program.body ?? []) {
    if (node.type !== 'ExportNamedDeclaration') {
      continue;
    }
    const exported = node as AstExportNamedDeclaration;
    if (exported.exportKind === 'type') {
      continue;
    }

    const declaration = exported.declaration;
    if (declaration?.type === 'VariableDeclaration') {
      const variableDeclaration = declaration as AstVariableDeclaration;
      if (variableDeclaration.kind === 'const') {
        for (const declarator of variableDeclaration.declarations ?? []) {
          if (isIdentifier(declarator.id)) {
            recordExport(declarator.id.name, declarator.init);
          }
        }
      }
    } else if (declaration?.type === 'FunctionDeclaration') {
      const functionDeclaration = declaration as AstFunctionDeclaration;
      if (isIdentifier(functionDeclaration.id)) {
        recordExport(functionDeclaration.id.name);
      }
    }

    for (const specifier of exported.specifiers ?? []) {
      if (specifier.exportKind === 'type') {
        continue;
      }
      const name = isIdentifier(specifier.exported)
        ? specifier.exported.name
        : isIdentifier(specifier.local)
          ? specifier.local.name
          : undefined;
      if (name) {
        recordExport(name);
      }
    }
  }

  metadata.methods = [...methodNames];
  return metadata;
}

function inferAutoPrerender(page: PageRenderingSource, options?: PageScanOptions): boolean {
  const isDynamic = page.params.length > 0 || page.catchAll;

  if (options?.output === 'static') {
    return !isDynamic || page.hasGetPrerenderPaths === true;
  }

  return page.island === true && !page.methods.includes('loader') && !isDynamic;
}

function resolvePageRendering(
  page: PageRenderingSource,
  options?: PageScanOptions,
): ResolvedPageRendering {
  if (page.island && page.ssr === false) {
    throw new Error(`pages: ssr = false is not valid for island page '${page.componentPath}'.`);
  }

  const ssrMode: SsrMode = page.ssr === true ? 'server' : page.ssr === false ? 'client' : 'auto';
  const prerenderMode: PrerenderMode =
    page.prerender === true ? 'force' : page.prerender === false ? 'disabled' : 'auto';
  const renderMode: PageRenderMode =
    page.island === true ? 'island' : ssrMode === 'client' ? 'client' : 'server';
  const shouldPrerender =
    prerenderMode === 'force' || (prerenderMode === 'auto' && inferAutoPrerender(page, options));

  return { ssrMode, prerenderMode, renderMode, shouldPrerender };
}

export async function scanPages(root: string, options?: PageScanOptions): Promise<PageScanResult> {
  const pagesDir = options?.pagesDir ?? options?.paths?.pagesDir ?? readProjectPaths(root).pagesDir;
  if (!existsSync(pagesDir)) {
    return { pages: [], layouts: [], namedLayouts: [] };
  }

  const pattern = `**/*.{${COMPONENT_EXTENSIONS.join(',')}}`;
  const files = await glob(pattern, { cwd: pagesDir, absolute: false });

  const pages: Array<PageDefinition> = [];
  const layouts: Array<LayoutDefinition> = [];
  const namedLayouts: Array<NamedLayoutDefinition> = [];

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
    const methods: Array<string> = [];
    let revalidate: number | undefined;
    let prerender: ExplicitBoolean;
    let ssr: ExplicitBoolean;
    let hasGetPrerenderPaths: boolean | undefined;
    const serverBase = hasIslandSuffix ? file.replace(`.island${ext}`, '') : file.replace(ext, '');
    for (const serverExt of SERVER_EXTENSIONS) {
      const candidate = `${serverBase}.server.${serverExt}`;
      if (existsSync(join(pagesDir, candidate))) {
        serverPath = candidate;
        const content = readFileSync(join(pagesDir, candidate), 'utf-8');
        const metadata = extractPageServerMetadata(candidate, content);
        methods.push(...metadata.methods);
        revalidate = metadata.revalidate;
        prerender = metadata.prerender;
        ssr = metadata.ssr;
        hasGetPrerenderPaths = metadata.hasGetPrerenderPaths;
        break;
      }
    }

    const rendering = resolvePageRendering(
      {
        componentPath: file,
        island,
        ssr,
        prerender,
        methods,
        params: route.params,
        catchAll: route.catchAll,
        hasGetPrerenderPaths,
      },
      options,
    );

    // Prerender → max revalidate (applies to all pages)
    if (rendering.shouldPrerender && revalidate === undefined) {
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
      ssr,
      ...rendering,
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
        `pages: Regular page '${page.componentPath}' is under an island layout. Add a .island suffix.`,
      );
    }
    // Check each directory level
    for (const seg of segments) {
      current = current ? `${current}/${seg}` : seg;
      if (layouts.some((l) => l.directory === current && l.island)) {
        throw new Error(
          `pages: Regular page '${page.componentPath}' is under an island layout. Add a .island suffix.`,
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
    if (!resolveNamedLayout(name, page.componentId, namedLayouts, page.componentPath)) {
      throw new Error(
        `pages: Page '${page.componentPath}' specifies layout '${page.layout}', but _layouts/${name}.vue was not found in any ancestor directory.`,
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
} from './layout-resolution.ts';
