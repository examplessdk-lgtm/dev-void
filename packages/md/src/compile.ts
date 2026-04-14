import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import {
  transformerMetaHighlight,
  transformerNotationDiff,
  transformerNotationHighlight,
  transformerNotationFocus,
  transformerNotationErrorLevel,
} from '@shikijs/transformers';
import matter from 'gray-matter';
import MarkdownExit from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import attrs from 'markdown-it-attrs';
import { full as emoji } from 'markdown-it-emoji';
import { createHighlighter, bundledLanguages, isSpecialLang, type BundledLanguage } from 'shiki';
import { containerPlugin } from './plugins/containers';
import { gitHubAlertsPlugin } from './plugins/github-alerts';
import { imagePlugin } from './plugins/image';
import { lineNumberPlugin } from './plugins/line-numbers';
import { linkPlugin } from './plugins/link';
import { preWrapperPlugin } from './plugins/pre-wrapper';
import { tocPlugin } from './plugins/toc';

export interface Heading {
  depth: number;
  slug: string;
  text: string;
}

export interface CompileResult {
  html: string;
  frontmatter: Record<string, unknown>;
  headings: Heading[];
  title: string;
}

export interface CompileOptions {
  shiki?: {
    themes?: { light: string; dark: string };
    langs?: string[];
  };
}

let compilerPromise: Promise<MarkdownExit> | null = null;

async function getCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  if (compilerPromise) {
    return compilerPromise;
  }
  compilerPromise = createCompiler(options);
  return compilerPromise;
}

async function createCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  const md = new MarkdownExit({ html: true, linkify: true });

  // Shiki highlighting with JS RegExp engine (no WASM) + lazy language loading
  const themes = options?.shiki?.themes ?? {
    light: 'github-light',
    dark: 'github-dark',
  };
  const highlighter = await createHighlighter({
    engine: createJavaScriptRegexEngine(),
    themes: [themes.light, themes.dark],
    langs: [],
  });
  const shikiTransformers = [
    transformerMetaHighlight(),
    transformerNotationDiff(),
    transformerNotationHighlight(),
    transformerNotationFocus(),
    transformerNotationErrorLevel(),
  ];
  md.renderer.rules.fence = async (tokens: any[], idx: number) => {
    const token = tokens[idx];
    const code = token.content;
    let lang = token.info ? token.info.split(/\s+/g)[0] : 'text';
    if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
      if (lang in bundledLanguages) {
        await highlighter.loadLanguage(lang as BundledLanguage);
      } else {
        lang = 'text';
      }
    }
    return highlighter.codeToHtml(code, {
      lang,
      themes,
      defaultColor: 'light',
      transformers: shikiTransformers,
      meta: { __raw: token.info },
    });
  };

  // Code block wrapping (must come after shiki, before line-numbers)
  md.use(preWrapperPlugin);

  // Container blocks: :::tip, :::warning, etc.
  md.use(containerPlugin);

  // Image path normalization + lazy loading
  md.use(imagePlugin, { lazyLoading: true });

  // Link handling: external attrs, .md normalization
  md.use(linkPlugin);

  // Line numbers (opt-in per code block by default)
  md.use(lineNumberPlugin, false);

  // GitHub alerts: > [!NOTE], > [!TIP], etc.
  md.use(gitHubAlertsPlugin);

  // Attribute syntax: {.class #id}
  md.use(attrs);

  // Emoji shortcodes
  md.use(emoji);

  // Heading anchors
  // @ts-expect-error markdown-it-anchor types reference @types/markdown-it, structurally incompatible with markdown-exit
  md.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });

  // [[toc]] directive
  md.use(tocPlugin);

  return md;
}

function extractHeadings(tokens: any[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[i + 1];
      const text = (
        inline?.children
          ?.filter((t: any) => t.type === 'text' || t.type === 'code_inline')
          .map((t: any) => t.content)
          .join('') ?? ''
      ).trim();
      headings.push({ depth, slug, text });
    }
  }
  return headings;
}

export async function compile(source: string, options?: CompileOptions): Promise<CompileResult> {
  const { data: frontmatter, content } = matter(source);
  const compiler = await getCompiler(options);

  const env: Record<string, unknown> = {};
  const tokens = compiler.parse(content, env);
  const headings = extractHeadings(tokens);
  const html = await compiler.renderAsync(content, env);

  const title = (frontmatter.title as string) ?? headings.find((h) => h.depth === 1)?.text ?? '';

  return { html, frontmatter, headings, title };
}

/** Reset the compiler (for testing or options change) */
export function resetCompiler(): void {
  compilerPromise = null;
}
