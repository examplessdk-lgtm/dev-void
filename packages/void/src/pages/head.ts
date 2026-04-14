/** Shape of a single page's head metadata. */
export interface HeadDescriptor {
  title?: string;
  meta?: Array<{ name?: string; property?: string; content?: string; charset?: string }>;
  link?: Array<{ rel: string; href: string; [key: string]: string | undefined }>;
  script?: Array<{ src?: string; innerHTML?: string; [key: string]: string | undefined }>;
  htmlAttrs?: Record<string, string>;
  bodyAttrs?: Record<string, string>;
}

/** Extended head config with template support (used in void.json). */
export interface HeadConfig extends HeadDescriptor {
  /** Title template — `%s` is replaced with the page title. */
  titleTemplate?: string;
}

/**
 * Merge head descriptors with precedence: page > middleware > config.
 *
 * - `title`: page wins; `titleTemplate` from config wraps it (`%s` replaced)
 * - `meta`: page overrides entries with same `name`/`property`; others appended
 * - `link`/`script`: concatenated (config first, then middleware, then page)
 * - `htmlAttrs`/`bodyAttrs`: shallow merge, page wins conflicts
 */
export function resolveHead(
  configHead: HeadConfig | undefined,
  middlewareHead: HeadDescriptor | undefined,
  pageHead: HeadDescriptor | undefined,
): HeadDescriptor | undefined {
  if (!configHead && !middlewareHead && !pageHead) {
    return undefined;
  }

  const result: HeadDescriptor = {};

  // --- title ---
  const title = pageHead?.title ?? middlewareHead?.title ?? configHead?.title;
  if (title !== undefined) {
    const template = configHead?.titleTemplate;
    result.title = template ? template.replace('%s', title) : title;
  }

  // --- meta (dedup by name/property, page wins) ---
  const metaMap = new Map<
    string,
    { name?: string; property?: string; content?: string; charset?: string }
  >();
  const metaOrder: string[] = [];
  for (const layer of [configHead, middlewareHead, pageHead]) {
    if (!layer?.meta) {
      continue;
    }
    for (const entry of layer.meta) {
      const key = entry.charset
        ? 'charset'
        : entry.property
          ? `property:${entry.property}`
          : `name:${entry.name ?? ''}`;
      if (!metaMap.has(key)) {
        metaOrder.push(key);
      }
      metaMap.set(key, entry);
    }
  }
  if (metaMap.size > 0) {
    result.meta = metaOrder.map((key) => metaMap.get(key)!);
  }

  // --- link (concatenated) ---
  const links: HeadDescriptor['link'] = [];
  for (const layer of [configHead, middlewareHead, pageHead]) {
    if (layer?.link) {
      links.push(...layer.link);
    }
  }
  if (links.length > 0) {
    result.link = links;
  }

  // --- script (concatenated) ---
  const scripts: HeadDescriptor['script'] = [];
  for (const layer of [configHead, middlewareHead, pageHead]) {
    if (layer?.script) {
      scripts.push(...layer.script);
    }
  }
  if (scripts.length > 0) {
    result.script = scripts;
  }

  // --- htmlAttrs (shallow merge, page wins) ---
  const htmlAttrs: Record<string, string> = {};
  let hasHtmlAttrs = false;
  for (const layer of [configHead, middlewareHead, pageHead]) {
    if (layer?.htmlAttrs) {
      Object.assign(htmlAttrs, layer.htmlAttrs);
      hasHtmlAttrs = true;
    }
  }
  if (hasHtmlAttrs) {
    result.htmlAttrs = htmlAttrs;
  }

  // --- bodyAttrs (shallow merge, page wins) ---
  const bodyAttrs: Record<string, string> = {};
  let hasBodyAttrs = false;
  for (const layer of [configHead, middlewareHead, pageHead]) {
    if (layer?.bodyAttrs) {
      Object.assign(bodyAttrs, layer.bodyAttrs);
      hasBodyAttrs = true;
    }
  }
  if (hasBodyAttrs) {
    result.bodyAttrs = bodyAttrs;
  }

  // Return undefined if nothing was set
  if (
    result.title === undefined &&
    !result.meta &&
    !result.link &&
    !result.script &&
    !result.htmlAttrs &&
    !result.bodyAttrs
  ) {
    return undefined;
  }

  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Serialize a HeadDescriptor to HTML tags for injection into `<head>`. */
export function renderHeadToString(head: HeadDescriptor): string {
  const parts: string[] = [];

  if (head.title !== undefined) {
    parts.push(`<title>${escapeHtml(head.title)}</title>`);
  }

  if (head.meta) {
    for (const entry of head.meta) {
      const attrs: string[] = [];
      if (entry.charset) {
        attrs.push(`charset="${escapeHtml(entry.charset)}"`);
      }
      if (entry.name) {
        attrs.push(`name="${escapeHtml(entry.name)}"`);
      }
      if (entry.property) {
        attrs.push(`property="${escapeHtml(entry.property)}"`);
      }
      if (entry.content !== undefined) {
        attrs.push(`content="${escapeHtml(entry.content)}"`);
      }
      parts.push(`<meta ${attrs.join(' ')}>`);
    }
  }

  if (head.link) {
    for (const entry of head.link) {
      const attrs = Object.entries(entry)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}="${escapeHtml(v!)}"`)
        .join(' ');
      parts.push(`<link ${attrs}>`);
    }
  }

  if (head.script) {
    for (const entry of head.script) {
      const { innerHTML, ...rest } = entry;
      const attrs = Object.entries(rest)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}="${escapeHtml(v!)}"`)
        .join(' ');
      if (innerHTML) {
        parts.push(`<script${attrs ? ' ' + attrs : ''}>${innerHTML}</script>`);
      } else if (attrs) {
        parts.push(`<script ${attrs}></script>`);
      }
    }
  }

  return parts.join('\n');
}

/** Serialize htmlAttrs to an attribute string (includes leading space). */
export function renderHtmlAttrs(head: HeadDescriptor): string {
  if (!head.htmlAttrs) {
    return '';
  }
  const attrs = Object.entries(head.htmlAttrs)
    .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
    .join(' ');
  return attrs ? ' ' + attrs : '';
}

/** Serialize bodyAttrs to an attribute string (includes leading space). */
export function renderBodyAttrs(head: HeadDescriptor): string {
  if (!head.bodyAttrs) {
    return '';
  }
  const attrs = Object.entries(head.bodyAttrs)
    .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
    .join(' ');
  return attrs ? ' ' + attrs : '';
}
