import { formatLogTailMarkdown } from '../../src/build-manager.ts';

/** Extract rendered log text while exercising the production check-run formatter. */
export async function renderCapturedLog(raw: string): Promise<string> {
  const markdown = await formatLogTailMarkdown([{ line: raw, lineEnding: 'none' }], 1);
  if (markdown === null) {
    return '';
  }
  const fence = /^(`{6,})text$/m.exec(markdown);
  if (!fence || !markdown.endsWith('\n' + fence[1])) {
    throw new Error('Expected fenced check-run log output');
  }
  return markdown.slice(fence.index + fence[0].length + 1, -(fence[1].length + 1));
}
