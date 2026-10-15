import { describe, expect, it } from 'vite-plus/test';
import { compile } from '../../src/compile.ts';
import { CODE_COPY_SCRIPT } from '../../src/plugins/pre-wrapper.ts';

/** Runs the copy script, then clicks a copy button whose code block has these lines. */
function clickCopy(lines: Array<string>, writeText: (text: string) => unknown): void {
  class FakeElement {}
  const button = Object.assign(new FakeElement(), {
    closest: () => button,
    classList: { add() {}, remove() {} },
    parentElement: {
      querySelector: () => ({
        querySelectorAll: () => lines.map((textContent) => ({ textContent })),
      }),
    },
  });
  let onClick: ((event: { target: unknown }) => void) | undefined;
  const body = CODE_COPY_SCRIPT.slice('<script>'.length, -'</script>'.length);
  new Function('window', 'document', 'navigator', 'Element', 'setTimeout', body)(
    {},
    {
      addEventListener: (_type: string, listener: typeof onClick) => {
        onClick = listener;
      },
    },
    { clipboard: { writeText } },
    FakeElement,
    () => {},
  );
  onClick!({ target: button });
}

describe('plugins', () => {
  describe('pre-wrapper', () => {
    it('wraps code blocks with language label and copy button', { timeout: 30_000 }, async () => {
      const result = await compile('```js\nconst x = 1;\n```');
      expect(result.html).toContain('class="language-js');
      expect(result.html).toContain('class="copy"');
      expect(result.html).toContain('class="lang"');
    });

    it('adds one copy script per page with code blocks', async () => {
      const result = await compile('```js\nconst x = 1;\n```\n\n```sh\nnpm i\n```');
      expect(result.html.match(/<script>/g)).toHaveLength(1);
      expect(result.html).toMatch(/navigator\.clipboard\.writeText[\s\S]*<\/script>$/);

      const prose = await compile('# Title');
      expect(prose.html).not.toContain('<script');
    });

    it('copy script drops the empty last line that Shiki adds', () => {
      const copied: Array<string> = [];
      clickCopy(['const x = 1;', '', 'const y = 2;', ''], (text) => {
        copied.push(text);
        return Promise.resolve();
      });
      expect(copied).toEqual(['const x = 1;\n\nconst y = 2;']);
    });

    it('copy script handles a rejected clipboard write', () => {
      const rejectionHandlers: Array<unknown> = [];
      const write = {
        then: (_onFulfilled: unknown, onRejected?: unknown) => {
          rejectionHandlers.push(onRejected);
          return write;
        },
        catch: (onRejected: unknown) => {
          rejectionHandlers.push(onRejected);
          return write;
        },
      };
      clickCopy(['x', ''], () => write);
      expect(rejectionHandlers.some((handler) => typeof handler === 'function')).toBe(true);
    });
  });

  describe('containers', () => {
    it('renders :::tip container', async () => {
      const result = await compile(':::tip\nThis is a tip.\n:::');
      expect(result.html).toContain('custom-block');
      expect(result.html).toContain('tip');
      expect(result.html).toContain('TIP');
      expect(result.html).toContain('This is a tip.');
    });

    it('renders :::warning container with custom title', async () => {
      const result = await compile(":::warning Be Careful\nDon't do this.\n:::");
      expect(result.html).toContain('warning');
      expect(result.html).toContain('Be Careful');
    });

    it('renders :::details as collapsible', async () => {
      const result = await compile(':::details Click Me\nHidden content.\n:::');
      expect(result.html).toContain('<details');
      expect(result.html).toContain('<summary>');
      expect(result.html).toContain('Click Me');
    });
  });

  describe('github-alerts', () => {
    it('renders > [!NOTE] alert', async () => {
      const result = await compile('> [!NOTE]\n> This is a note.');
      expect(result.html).toContain('github-alert');
      expect(result.html).toContain('note');
      expect(result.html).toContain('NOTE');
      expect(result.html).toContain('This is a note.');
    });

    it('renders > [!WARNING] alert', async () => {
      const result = await compile('> [!WARNING]\n> Careful here.');
      expect(result.html).toContain('warning');
      expect(result.html).toContain('WARNING');
    });
  });

  describe('link', () => {
    it('adds target=_blank to external links', async () => {
      const result = await compile('[Google](https://google.com)');
      expect(result.html).toContain('target="_blank"');
      expect(result.html).toContain('rel="noreferrer"');
    });

    it('normalizes .md links', async () => {
      const result = await compile('[Guide](./guide.md)');
      expect(result.html).toContain('./guide');
      expect(result.html).not.toContain('.md');
    });
  });

  describe('image', () => {
    it('adds loading=lazy to images', async () => {
      const result = await compile('![alt](./img.png)');
      expect(result.html).toContain('loading="lazy"');
    });
  });

  describe('line-numbers', () => {
    it('adds line numbers when :line-numbers is specified', async () => {
      const result = await compile('```js :line-numbers\nconst x = 1;\nconst y = 2;\n```');
      expect(result.html).toContain('line-numbers-wrapper');
      expect(result.html).toContain('line-numbers-mode');
    });
  });

  describe('emoji', () => {
    it('converts emoji shortcodes', async () => {
      const result = await compile(':tada: :heart:');
      expect(result.html).toContain('\u{1F389}');
      expect(result.html).toContain('\u{2764}');
    });
  });

  describe('toc', () => {
    it('renders [[toc]] directive', async () => {
      const result = await compile('[[toc]]\n\n## First\n\n## Second\n\n### Third');
      expect(result.html).toContain('table-of-contents');
      expect(result.html).toContain('First');
      expect(result.html).toContain('Second');
      expect(result.html).toContain('Third');
    });
  });
});
