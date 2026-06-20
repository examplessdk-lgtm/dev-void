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
import type { RuleCore, Token } from 'markdown-exit';
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

export type Heading = Readonly<{
  depth: number;
  slug: string;
  text: string;
}>;

export type CompileResult = Readonly<{
  html: string;
  frontmatter: Record<string, unknown>;
  headings: ReadonlyArray<Heading>;
  title: string;
}>;

export type CompileOptions = Readonly<{
  shiki?: {
    themes?: { light: string; dark: string };
    langs?: ReadonlyArray<string>;
  };
}>;

let compilerPromise: Promise<MarkdownExit> | null = null;

async function getCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  if (compilerPromise) {
    return compilerPromise;
  }
  compilerPromise = createCompiler(options);
  return compilerPromise;
}

async function createCompiler(options?: CompileOptions): Promise<MarkdownExit> {
  const markdown = new MarkdownExit({ html: true, linkify: true });

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
  markdown.renderer.rules.fence = async (tokens: ReadonlyArray<Token>, tokenIndex: number) => {
    const token = tokens[tokenIndex];
    const code = token.content;
    let lang = token.info ? token.info.split(/\s+/g)[0] : 'text';
    if (!isSpecialLang(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
      if (lang in bundledLanguages) {
        await highlighter.loadLanguage(lang as BundledLanguage);
      } else {
        lang = 'text';
      }
    }
    // `markdown-it-attrs` strips the `{1,3-5}` line-highlight ranges out of
    // `token.info` at parse time (it treats `{…}` as an attribute block), so by
    // render time only the language remains. The `stash_fence_info` core rule
    // preserves the original info string on `token.meta.rawInfo` before that
    // happens; fall back to `token.info` when it is absent (a fence with no
    // curly meta). Without this, `transformerMetaHighlight` never sees the
    // ranges and line highlighting silently no-ops.
    const rawInfo = (token.meta as { rawInfo?: string } | null)?.rawInfo ?? token.info;
    return highlighter.codeToHtml(code, {
      lang,
      themes,
      defaultColor: 'light',
      transformers: shikiTransformers,
      meta: { __raw: rawInfo },
    });
  };

  // Code block wrapping (must come after shiki, before line-numbers)
  markdown.use(preWrapperPlugin);

  // Container blocks: :::tip, :::warning, etc.
  markdown.use(containerPlugin);

  // Image path normalization + lazy loading
  markdown.use(imagePlugin, { lazyLoading: true });

  // Link handling: external attrs, .md normalization
  markdown.use(linkPlugin);

  // Line numbers (opt-in per code block by default)
  markdown.use(lineNumberPlugin, false);

  // GitHub alerts: > [!NOTE], > [!TIP], etc.
  markdown.use(gitHubAlertsPlugin);

  // Preserve the raw fence info string (e.g. `ts {1,3-5}`) on the token before
  // `markdown-it-attrs` consumes the `{…}` as an attribute block. Anchored
  // after `block` so fence tokens exist, and before `curly_attributes` (which
  // runs after `inline`), so the fence renderer can still feed the ranges to
  // Shiki's `transformerMetaHighlight` via `meta.__raw`.
  const stashFenceInfo: RuleCore = (state) => {
    for (const token of state.tokens) {
      if (token.type === 'fence') {
        token.meta = { ...token.meta, rawInfo: token.info };
      }
    }
  };
  markdown.core.ruler.after('block', 'stash_fence_info', stashFenceInfo);

  // Attribute syntax: {.class #id}
  markdown.use(attrs);

  // Emoji shortcodes
  markdown.use(emoji);

  // Heading anchors
  // @ts-expect-error markdown-it-anchor types reference @types/markdown-it, structurally incompatible with markdown-exit
  markdown.use(anchor, {
    permalink: anchor.permalink.ariaHidden({ placement: 'before' }),
  });

  // [[toc]] directive
  markdown.use(tocPlugin);

  return markdown;
}

function extractHeadings(tokens: ReadonlyArray<Token>): ReadonlyArray<Heading> {
  const headings: Array<Heading> = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type === 'heading_open') {
      const depth = Number(token.tag.slice(1));
      const slug = token.attrGet?.('id') ?? '';
      const inline = tokens[tokenIndex + 1];
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

  const title =
    (frontmatter.title as string) ?? headings.find((heading) => heading.depth === 1)?.text ?? '';

  return { html, frontmatter, headings, title };
}

/** Reset the compiler (for testing or options change) */
export function resetCompiler(): void {
  compilerPromise = null;
}
