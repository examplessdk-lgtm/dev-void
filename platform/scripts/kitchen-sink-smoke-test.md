# Kitchen Sink Smoke Tests

Use `playground/kitchen-sink` to verify a platform with a disposable app. The automated suite resets the app's database, KV, and storage, then exercises navigation, mutations, authentication, queues, and caching.

Deploy the app to the platform you want to test, then pass its URL explicitly from the repository root:

```sh
vp exec playwright install chromium
SMOKE_URL=https://kitchen-sink.apps.example.com node platform/scripts/kitchen-sink-smoke-test.ts
```

Use an app whose data can be deleted. The script has no default destination. If Cloudflare Access protects the app, supply that application's `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from your secret manager.

The checklist below can also be run manually or with browser automation. Use unique values for created records, wait for each mutation to appear, and remove test records afterward. KV listings are eventually consistent; poll them instead of relying on a fixed delay. Record each result and report failures after completing the remaining cases.

## Test Cases

### 1. Home page SSR + asset caching

1. Visit `/`.
2. Assert the page contains "Kitchen Sink" and "Auth" in its text.
3. Inspect the page's HTML source for hashed asset URLs (e.g. `.js` or `.css` files with hash in the filename).
4. Use the browser to GET one of those asset URLs with a cache-busting query parameter, and assert its `Cache-Control` header contains `immutable`. Inspect a `GET` response rather than `HEAD`: the dispatch edge cache stamps `immutable` on `GET`s to hashed paths only, and a conditional `HEAD` is answered from the entry the browser already stored, so it reports `no-store` and looks like a failure.

   ```js
   const el =
     document.querySelector('script[src*="/assets/"]') ||
     document.querySelector('link[href*="/assets/"]');
   const url = el.src || el.href;
   const xhr = new XMLHttpRequest();
   xhr.open('GET', url + (url.includes('?') ? '&' : '?') + 'smoke=' + Date.now(), false);
   xhr.send();
   xhr.status + ' ' + xhr.getResponseHeader('cache-control');
   ```

   Expect `200 public, max-age=31536000, immutable`.

### 2. SPA navigation (no full reload)

1. Visit `/`.
2. Run JS to set a marker on window: `window.__SPA_MARKER = true`.
3. Click the "DB" link (navigates to `/db`).
4. Wait for the h1 to contain "DB".
5. Assert the URL is now `/db`.
6. Run JS to check `window.__SPA_MARKER` — assert it is still `true` (proves no full page reload).
7. Click the "KV" link (navigates to `/kv`).
8. Wait for the h1 to contain "KV".
9. Assert the URL is now `/kv`.

### 3. Layout persistence across navigation

1. Visit `/`.
2. Run JS to stamp the nav element: `document.querySelector("nav").__stamp = 1`.
3. Click the "Env" link (navigates to `/env`).
4. Wait for the h1 to contain "Env".
5. Run JS to read `document.querySelector("nav").__stamp` — assert it equals `1` (proves layout DOM was not recreated).

### 4. DB — create and delete a note

1. Visit `/db`.
2. Fill the title input (placeholder "Note title") with a unique value like `smoke-<timestamp>`.
3. Fill the body input (placeholder "Note body") with `test body`.
4. Click the "Add Note" button.
5. Wait for the unique title to appear in the page text.
6. Assert the page contains both the title and "test body".
7. Find the table row containing the title and click its "Delete" button.
8. Wait for the title to disappear from the page.

### 5. KV — set and delete a key

1. Visit `/kv`.
2. Fill the key input (placeholder "my-key") with a unique value like `smoke-kv-<timestamp>`.
3. Fill the value input (placeholder "my-value") with `hello`.
4. Click the "Set" button.
5. Fill the `lookup` input with our key, confirm `<key> = <value>` appears on page.
6. Reload page to check if the key appears in the table. **This will take a while as kv.list() is eventually consistent, not instant**
7. Find the table row containing the key and click its "Delete" button.
8. Wait for the key to disappear from the page.

### 6. Storage — upload and delete a file

1. Visit `/storage`.
2. Upload a file named `smoke-test.txt` with content `hello world` via the file input.
3. Click the "Upload" button.
4. Wait for "smoke-test.txt" to appear in the page.
5. Find the table row containing "smoke-test.txt" and click its "Delete" button.
6. Wait for "smoke-test.txt" to disappear from the page.

### 7. Env — displays bindings

1. Visit `/env`.
2. Assert the page text contains "DB" and "KV".

### 8. Queues — send message and see consumer result

1. Visit `/queues`.
2. Fill the key input (placeholder "my-key") with a unique value like `smoke-q-<timestamp>`.
3. Fill the value input (placeholder "my-value") with `queued`.
4. Click the "Send to Queue" button.
5. Poll for up to 45 seconds: reload `/queues` every 2-3 seconds and check if the unique key appears in the "Processed Results" table. Results are written to D1 (strongly consistent), so they appear immediately once the consumer processes the message.
6. Assert the key was found within the timeout.
7. Delete the test row from the table.

### 9. Auth — register, login, protected route, logout

1. Visit `/auth`.
2. Assert the page shows "Not logged in".
3. Click the "Register" tab button.
4. In the "Email Register" section:
   - Fill the email input with a unique email like `smoke-<timestamp>@example.com`.
   - Fill the password input with `s3cureP@ss!`.
   - Fill the name input (placeholder "Name (optional)") with `Smoke User`.
   - Click the "Register" submit button.
5. Wait for "Not logged in" to disappear — assert the page now shows the email address (user is logged in).
6. Click the "GET /api/profile" button.
7. Wait for a `<pre>` element to appear containing `"user"`.
8. Assert the `<pre>` response contains the email address.
9. Click the "Logout" button.
10. Wait for "Not logged in" to reappear.
11. Click the "Login" tab button.
12. In the "Email Login" section:
    - Fill the email input with the same email used above.
    - Fill the password input with `s3cureP@ss!`.
    - Click the "Login" submit button.
13. Wait for "Not logged in" to disappear — assert the user is logged in again.

### 10. Cron — heartbeat is running

1. Visit `/cron`.
2. Check if a heartbeat timestamp is displayed (a `<code>` element with an ISO timestamp).
3. If present, assert it is a valid ISO date and was recorded within the last 5 minutes.
4. If "No heartbeat recorded yet" is shown, note this as a warning (cron may not have fired yet) — not a hard failure.

### 11. ISR Revalidation

1. Visit `/revalidate`.
2. Note the "Rendered at" timestamp.
3. Click the "Revalidate /revalidate" button.
4. Wait for the button to return to its non-disabled state.
5. Reload the page (navigate to `/revalidate` again).
6. Check the "Last revalidation" field — assert it is no longer "never" (shows a timestamp).
