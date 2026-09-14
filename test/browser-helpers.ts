import type { Page } from 'playwright';

/** Each island loads independently; one hydrated island says nothing about its siblings. */
export async function waitForIslandsHydrated(
  page: Page,
  minimumCount = 1,
  timeout?: number,
): Promise<void> {
  await page.waitForFunction(
    (minimum) => {
      const islands = Array.from(document.querySelectorAll('[data-island]'));
      return (
        islands.length >= minimum &&
        islands.every((island) => island.getAttribute('data-hydrated') === 'true')
      );
    },
    minimumCount,
    { timeout },
  );
}

/** Retain the events that distinguish hydration errors, native navigation, and Vite reloads. */
export function collectBrowserDiagnostics(page: Page): () => string {
  const events: Array<string> = [];
  const record = (message: string) => {
    events.push(message);
    if (events.length > 100) {
      events.shift();
    }
  };

  page.on('console', (message) => record(`console.${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => record(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    record(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
  );
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      record(`document: ${request.method()} ${request.url()}`);
    }
  });
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const message = String(payload);
      if (message.includes('full-reload') || message.includes('"type":"error"')) {
        record(`websocket: ${message}`);
      }
    });
  });

  return () => `Browser events:\n${events.join('\n')}`;
}
