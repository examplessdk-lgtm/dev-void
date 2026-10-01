import { chromium } from 'playwright';
import { app } from '../../src/index.ts';
import type { TestEnv } from './helpers.ts';

/** Exercise the rendered native form locally, without provider or public HTTP. */
export async function nativeFormSubmission(input: {
  env: TestEnv;
  origin: string;
  cookie: string;
  path: string;
  fields: Record<string, string>;
  button: string;
  noReferrer?: boolean;
}) {
  const browser = await chromium.launch();
  let pagePolicy: string | null = null;
  let submission:
    | { origin: string | undefined; referrer: string | undefined; status: number }
    | undefined;
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const split = input.cookie.indexOf('=');
    await context.addCookies([
      {
        name: input.cookie.slice(0, split),
        value: input.cookie.slice(split + 1),
        url: input.origin,
        httpOnly: true,
        secure: true,
      },
    ]);
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== input.origin || request.resourceType() !== 'document') {
        await route.abort();
        return;
      }
      const headers = await request.allHeaders();
      const response = await app.fetch(
        new Request(request.url(), {
          method: request.method(),
          headers,
          ...(request.method() === 'POST' ? { body: request.postData() ?? '' } : {}),
        }),
        input.env,
      );
      const responseHeaders = Object.fromEntries(response.headers);
      if (request.method() === 'GET') {
        pagePolicy = response.headers.get('Referrer-Policy');
        if (input.noReferrer) {
          responseHeaders['referrer-policy'] = 'no-referrer';
        }
      } else {
        submission = { origin: headers.origin, referrer: headers.referer, status: response.status };
      }
      // Preserve actual API status evidence without letting a redirect escape
      // Playwright's first-request routing and resolve an external fixture host.
      if (response.status >= 300 && response.status < 400) {
        delete responseHeaders.location;
        await route.fulfill({
          status: 200,
          headers: responseHeaders,
          body: '<h1>Local form handoff</h1>',
        });
        return;
      }
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await page.goto(`${input.origin}${input.path}`);
    for (const [name, value] of Object.entries(input.fields)) {
      await page.locator(`input[name="${name}"]`).fill(value);
    }
    const button = page.getByRole('button', { name: input.button, exact: true });
    const formAction = await button.evaluate(
      (element) => (element as HTMLButtonElement).form?.action,
    );
    if (!formAction) {
      throw new Error('The native submit button has no form action.');
    }
    await Promise.all([page.waitForURL(formAction), button.click()]);
    if (!submission) {
      throw new Error('The native form did not reach the local API.');
    }
    return { pagePolicy, submission };
  } finally {
    await browser.close();
  }
}
