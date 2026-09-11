Follow these instructions to test the kitchen sink app.

- Production URL: https://kitchen-sink.void.app/
- Staging URL: https://kitchen-sink.staging.void.app/

## High-level instructions

- Always first confirm with the user whether we are testing staging or production.
- Use the `/agent-browser` skill for browser automation. If the user doesn't have this skill installed, prompt them to install with `npx skills add vercel-labs/agent-browser`.
- **DO NOT use Playwright MCP tools** directly. They have a separate page context from `agent-browser`.
- The source code of the app is in `playground/kitchen-sink`.
- If a test case fails, remember the failure and move on to the next case.
- Print a summary of all results (pass/fail) at the end.

## Techniques

These patterns came up repeatedly during testing. Use them to avoid common pitfalls.

**Deleting a specific row from a table:** The snapshot shows multiple "Delete" buttons without row context. Use JS eval to find the right row:

```bash
agent-browser eval --stdin <<'EVALEOF'
const row = Array.from(document.querySelectorAll("tr")).find(r => r.textContent.includes("TARGET"));
if (row) { row.querySelector("button").click(); "deleted" } else { "not found" }
EVALEOF
```

**File uploads:** The native file chooser dialog doesn't work well in headless mode. Use the DataTransfer API via JS eval instead:

```bash
agent-browser eval --stdin <<'EVALEOF'
const input = document.querySelector('input[type="file"]');
const dt = new DataTransfer();
dt.items.add(new File(["file content"], "filename.txt", { type: "text/plain" }));
input.files = dt.files;
input.dispatchEvent(new Event("change", { bubbles: true }));
"file set"
EVALEOF
```

**Waiting after mutations:** After clicking form submit buttons, the app reloads data via the server. Always wait 2-3 seconds (or poll) before asserting.

**JS eval limitations:** `agent-browser eval` does not support top-level `await`. Use synchronous code only. For complex expressions with nested quotes, always use `--stdin` with heredoc to avoid shell escaping issues.

## Test Cases

### 1. Home page SSR + asset caching

1. Visit `/`.
2. Assert the page contains "Kitchen Sink" and "Auth" in its text.
3. Inspect the page's HTML source for hashed asset URLs (e.g. `.js` or `.css` files with hash in the filename).
4. Use an **in-browser sync XHR** (`XMLHttpRequest` via `agent-browser eval`) to HEAD-request one of those asset URLs and assert its `Cache-Control` header contains `immutable`. Do NOT use `curl` — Cloudflare edge cache rules rewrite headers differently for browser vs non-browser requests.

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
