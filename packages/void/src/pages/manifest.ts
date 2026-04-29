import { resolveLayoutIds } from './layout-resolution.ts';
import type { PageScanResult } from './types.ts';

/**
 * Generates the component import map and layout tree as code strings.
 * Used by both SSR renderer and client entry virtual modules.
 */
export function generateComponentManifest(scan: PageScanResult, pagesDir: string): string {
  const lines: Array<string> = [];

  // Component lazy imports
  lines.push('const components = {');
  for (const page of scan.pages) {
    const importPath = `${pagesDir}/${page.componentPath}`;
    lines.push(
      `  ${JSON.stringify(page.componentId)}: () => import(${JSON.stringify(importPath)}),`,
    );
  }
  for (const layout of scan.layouts) {
    const importPath = `${pagesDir}/${layout.filePath}`;
    const layoutId = layout.directory ? `${layout.directory}/layout` : 'layout';
    lines.push(`  ${JSON.stringify(layoutId)}: () => import(${JSON.stringify(importPath)}),`);
  }
  for (const nl of scan.namedLayouts) {
    const importPath = `${pagesDir}/${nl.filePath}`;
    const layoutId = nl.directory ? `${nl.directory}/_layouts/${nl.name}` : `_layouts/${nl.name}`;
    lines.push(`  ${JSON.stringify(layoutId)}: () => import(${JSON.stringify(importPath)}),`);
  }
  lines.push('};');

  // Layout tree (component ID → ordered layout IDs)
  lines.push('const layoutTree = {');
  for (const page of scan.pages) {
    const chain = resolveLayoutIds(page, scan.layouts, scan.namedLayouts);
    if (chain.length > 0) {
      lines.push(`  ${JSON.stringify(page.componentId)}: ${JSON.stringify(chain)},`);
    }
  }
  lines.push('};');

  // Route metadata (sparse — only island pages)
  lines.push('const routeMeta = {');
  for (const page of scan.pages) {
    if (page.island) {
      lines.push(`  ${JSON.stringify(page.componentId)}: { island: true },`);
    }
  }
  lines.push('};');

  // Route pattern table for client-side URL matching
  lines.push('const routes = [');
  for (const page of scan.pages) {
    const regex = patternToRegex(page.pattern);
    lines.push(`  { pattern: ${regex}, id: ${JSON.stringify(page.componentId)} },`);
  }
  lines.push('];');

  lines.push(`function matchRoute(url) {
  const path = new URL(url, "http://x").pathname;
  for (const r of routes) {
    if (r.pattern.test(path)) return r.id;
  }
  return null;
}`);

  return lines.join('\n');
}

function patternToRegex(pattern: string): string {
  const re = pattern
    .replace(/:[^/{}]+\{\.\+\}/g, '(.+)') // catch-all :path{.+} (before escaping)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex-special characters
    .replace(/\*/, '(.*)') // wildcard *
    .replace(/:[^/]+/g, '([^/]+)') // dynamic :param
    .replace(/\//g, '\\/'); // escape forward slashes
  return `/^${re}$/`;
}
