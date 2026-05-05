import spawn from 'cross-spawn';
import { join } from 'pathe';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPort, killChild, waitForServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

let browser: Browser;
let port: number;
let base: string;

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  return page;
}

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]');
}

async function waitForBodyText(page: Page, text: string) {
  await page.waitForFunction((expected) => document.body.textContent?.includes(expected), text);
}

function collectUnexpectedBrowserErrors(page: Page) {
  const errors: Array<string> = [];

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return;
    }

    const text = message.text();
    if (text.includes('favicon.ico')) {
      return;
    }

    errors.push(text);
  });

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  return errors;
}

describe('playground/websockets', () => {
  let child: ReturnType<typeof spawn>;
  let stderr = '';

  beforeAll(async () => {
    browser = await chromium.launch();

    port = await getPort();
    base = `http://127.0.0.1:${port}`;

    child = spawn(
      'pnpm',
      [
        '--dir',
        'playground/websockets',
        'exec',
        'vite',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      },
    );

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });

    await waitForServer(base, 20_000);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    await browser?.close();
    if (stderr.includes('error when starting dev server')) {
      throw new Error(stderr);
    }
  });

  it('chat reconnects to a fresh room and sends a typed message', async () => {
    const page = await newPage();
    const errors = collectUnexpectedBrowserErrors(page);
    const room = `e2e-room-${Date.now().toString(36)}`;
    const name = 'e2e-user';
    const message = `hello-${room}`;

    try {
      await page.goto(`${base}/chat`);
      await waitForHydration(page);
      await waitForBodyText(page, 'Connected to room "general"');

      await page.getByLabel('Room:').fill(room);
      await page.getByLabel('Display name:').fill(name);
      await page.getByRole('button', { name: 'Reconnect' }).click();

      await page.waitForFunction(
        ([expectedRoom, expectedName]) => {
          const text = document.body.textContent || '';
          return (
            text.includes(`room: ${expectedRoom}`) &&
            text.includes(`name: ${expectedName}`) &&
            text.includes(`Connected to room "${expectedRoom}"`) &&
            text.includes(`${expectedName} joined ${expectedRoom}`)
          );
        },
        [room, name],
      );

      await page.getByLabel('Message:').fill(message);
      await page.getByRole('button', { name: 'Send' }).click();
      await waitForBodyText(page, message);

      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('notifications stream typed items and acknowledge one', async () => {
    const page = await newPage();
    const errors = collectUnexpectedBrowserErrors(page);

    try {
      await page.goto(`${base}/notifications`);
      await waitForHydration(page);
      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return text.includes('status: open') && text.includes('stream idle');
      });

      await page.getByLabel('Items per stream:').selectOption('3');
      await page.getByRole('button', { name: 'Start stream' }).click();

      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return (
          text.includes('stream active, 3 notifications remaining') &&
          text.includes('Notification 1')
        );
      });

      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return (
          text.includes('stream finished after 3 items') &&
          text.includes('Notification 1') &&
          text.includes('Notification 2') &&
          text.includes('Notification 3')
        );
      });

      const latestItem = page.locator('li', { hasText: 'Notification 3' }).first();
      await latestItem.getByRole('button', { name: 'Acknowledge' }).click();

      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('li')).some(
          (item) =>
            item.textContent?.includes('Notification 3') && item.textContent?.includes('Acked'),
        ),
      );
      await page.waitForFunction(() => document.body.textContent?.includes('acknowledged '));

      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
