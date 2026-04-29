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
import type { Token } from 'markdown-exit';
import anchor from 'markdown-it-anchor';
import attrs from 'markdown-it-attrs';
import { full as emoji } from 'markdown-it-emoji';
import { createHighlighter, bundledLanguages, isSpecialLang, type BundledLanguage } from 'shiki';
import { containerPlugin } from './plugins/containers.ts';
import { gitHubAlertsPlugin } from './plugins/github-alerts.ts';
import { imagePlugin } from './plugins/image.ts';
import { lineNumberPlugin } from './plugins/line-numbers.ts';
import { linkPlugin } from './plugins/link.ts';
import { preWrapperPlugin } from './plugins/pre-wrapper.ts';
import { tocPlugin } from './plugins/toc.ts';

export interface Heading {
  depth: number;
  slug: string;
  text: string;
}

export interface CompileResult {
  html: string;
  frontmatter: Record<string, unknown>;
  headings: Array<Heading>;
  title: string;
}

export interface CompileOptions {
  shiki?: {
    themes?: { light: string; dark: string };
    langs?: Array<string>;
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
  md.renderer.rules.fence = async (tokens: Array<Token>, idx: number) => {
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

function extractHeadings(tokens: Array<Token>): Array<Heading> {
  const headings: Array<Heading> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[i + 1];
      const text = (
        inline?.children
          ?.filter((child) => child.type === 'text' || child.type === 'code_inline')
          .map((child) => child.content)
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
