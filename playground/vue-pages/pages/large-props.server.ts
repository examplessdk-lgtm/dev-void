import { defineHandler } from "void";

export interface Props {
  title: string;
  /** Simulates a large payload (e.g. CMS record map, pre-rendered HTML) */
  data: Record<string, unknown>;
  /** Simulates pre-rendered HTML from a CMS */
  prerenderedHtml: string;
}

/**
 * Reproduces: x-void-page-data header serializes the entire page object into
 * an HTTP response header. For pages with large props (e.g. CMS record maps,
 * pre-rendered HTML), this exceeds HTTP header size limits, causing fetch errors.
 *
 * Real-world example: a Notion-powered blog where each page returns a full
 * ExtendedRecordMap (~30-70KB) plus pre-rendered HTML (~50-200KB).
 *
 * The issue manifests in SSG prerendering via Miniflare's dispatchFetch(),
 * where large/non-ASCII header values cause "fetch failed" errors.
 */
function generateLargeData(): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  // Simulate a CMS record map with many blocks (~200KB)
  // Include Unicode content (common in CMS data) which can trigger
  // stricter header validation in HTTP transports
  for (let i = 0; i < 500; i++) {
    data[`block_${i}`] = {
      id: `block-${i}-${"abcdef0123456789".repeat(12)}`,
      type: "paragraph",
      properties: {
        title: [
          [
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
              "Sed do eiusmod tempor incididunt ut labore — et dolore magna aliqua. " +
              "日本語テスト・中文测试・한국어 테스트. " +
              'Emoji: 🚀📦✨ Special chars: <div class="test">&amp;</div>',
          ],
        ],
      },
      content: [`child-${i}-a`, `child-${i}-b`, `child-${i}-c`],
      format: { block_width: 680, block_height: 400, block_color: "gray" },
      created_time: 1700000000000,
      last_edited_time: 1700000000000,
    };
  }
  return data;
}

function generatePrerenderedHtml(): string {
  // Simulate pre-rendered HTML from a CMS (~100KB)
  const blocks: string[] = [];
  for (let i = 0; i < 300; i++) {
    blocks.push(
      `<div class="notion-block notion-text-block" data-block-id="block-${i}">` +
        `<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. ` +
        `Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ` +
        `Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p></div>`,
    );
  }
  return blocks.join("\n");
}

export async function getPrerenderPaths() {
  return [{}];
}

export const loader = defineHandler<Props>(() => {
  return {
    title: "Large Props Page",
    data: generateLargeData(),
    prerenderedHtml: generatePrerenderedHtml(),
  };
});
