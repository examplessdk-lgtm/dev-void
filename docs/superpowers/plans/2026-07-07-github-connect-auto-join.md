# `void github connect` auto-join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `void github connect` finds zero active installations (or a missing `--installation` id) on a TTY, auto-run the existing join browser OAuth flow instead of telling the user to install an app their org already installed.

**Architecture:** CLI-only change in `packages/void/src/cli/github-cmd.ts`. Extract the join browser round-trip from `runGithubJoin` into a reusable `performGithubJoin(client)` helper; `runConnect` calls it as a fallback, then re-lists installations. Also fix the member repo dead-end: the server redacts `repositories` to `[]` for non-owner rows, so `selected` + empty list must prompt for `owner/repo` on a TTY instead of erroring. No server changes.

**Tech Stack:** TypeScript (Node 24 native type stripping), `@clack/prompts`, vitest via `vite-plus/test`, `vp` (Vite+) task runner.

**Spec:** `docs/superpowers/specs/2026-07-07-github-connect-auto-join-design.md`

## Global Constraints

- Repo: `/Users/brooklyn/workspace/voidzero/void`. Do NOT touch `void-platform` or any server code. All production changes live in `packages/void/src/cli/github-cmd.ts`; tests in `packages/void/test/unit/`.
- `runGithubJoin`'s user-facing behavior (messages, exit codes) must remain byte-identical.
- Exact error copy (verbatim, including backticks):
  - TTY, after auto-join found nothing: `No GitHub App installation found for your account or your organizations. Run \`void github install\` first.`
  - non-TTY, empty list: `No active GitHub App installation. Run \`void github install\` first, or \`void github join\` if your organization already installed the Void GitHub App.`
  - non-TTY, `selected` + empty repositories: `connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.`
- The auto-join browser flow must never start when `process.stdin.isTTY !== true`, and must run at most once per `runConnect` invocation.
- A 503 `github_oauth_not_configured` from the join flow inside `runConnect` falls through to the install-first error (exit 1); it must NOT print `Organization installation sharing is not enabled on this Void instance.` (that copy stays exclusive to `void github join`).
- Test commands: `vp test run packages/void/test/unit/github-connect-cmd.test.ts` and `vp test run packages/void/test/unit/github-join-cmd.test.ts`. Typecheck: `vp run --filter ./packages/void typecheck`. Run from repo root. Do not run the full suite until final verification.
- Commit messages follow the repo's conventional style, e.g. `feat: auto-join org installations during \`void github connect\` (…)`.

---

### Task 1: Extract `performGithubJoin` from `runGithubJoin`

Pure refactor — existing join tests are the safety net.

**Files:**

- Modify: `packages/void/src/cli/github-cmd.ts:322-373` (`runGithubJoin`)
- Test (existing, must stay green): `packages/void/test/unit/github-join-cmd.test.ts`

**Interfaces:**

- Consumes: `awaitBrowserCallback`, `createCodeVerifier`, `createCodeChallenge` from `./auth.ts`; `PlatformClient`, `PlatformApiError` from `./client.ts` (all already imported).
- Produces: `export async function performGithubJoin(client: PlatformClient): Promise<number>` — returns joined count, throws `PlatformApiError` (including 503 `github_oauth_not_configured`). Task 2 depends on this exact name/signature.

- [ ] **Step 1: Replace `runGithubJoin` with helper + wrapper**

Replace the whole function body at `github-cmd.ts:322-373` with:

```ts
/**
 * Browser round-trip (localhost + PKCE) that joins the caller to their
 * organization's shared GitHub App installations. Returns the number of
 * installations joined. Throws PlatformApiError — including the 503
 * `github_oauth_not_configured` — so callers own the user-facing handling
 * (`runGithubJoin` prints and exits; the connect auto-join fallback falls
 * through to its install-first error).
 */
export async function performGithubJoin(client: PlatformClient): Promise<number> {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = randomBytes(32).toString('hex');

  // completeGithubJoin runs INSIDE the request handler (via finalize), so the
  // browser only shows the success page after the join actually succeeds.
  const { count } = await awaitBrowserCallback<{ status: 'joined'; count: number }>({
    state,
    buildAuthUrl: async (callback) => {
      callback.searchParams.set('state', state);
      const { url } = await client.getGithubJoinUrl(callback.href, challenge);
      return url;
    },
    describeError: (p) => (p.get('error') ? 'GitHub authorization failed.' : null),
    onUrl: (url) =>
      log.message(
        `Open this URL to join your organization's shared GitHub App installations:\n${pc.cyan(url)}`,
      ),
    finalize: async (params) => {
      const joinCode = params.get('join_code');
      if (!joinCode) {
        throw new Error('github: join callback did not return a join code.');
      }
      return client.completeGithubJoin(joinCode, verifier);
    },
  });
  return count;
}

export async function runGithubJoin(root: string, client: PlatformClient): Promise<void> {
  void root; // Signature parity with runGithubLink; routing uses `client`.

  let count: number;
  try {
    count = await performGithubJoin(client);
  } catch (err) {
    // Fail closed: org-installation sharing OAuth is not configured on this
    // instance. The membership flow has no already-joined conflict to map.
    if (
      err instanceof PlatformApiError &&
      err.status === 503 &&
      err.code === 'github_oauth_not_configured'
    ) {
      log.error('Organization installation sharing is not enabled on this Void instance.');
      process.exit(1);
    }
    throw err;
  }

  if (count === 0) {
    log.info('No new installations to join.');
  } else {
    log.success(`Joined ${count} installation${count === 1 ? '' : 's'}.`);
    log.message('Run `void github installations` to see them, then `void github connect`.');
  }
}
```

- [ ] **Step 2: Verify existing join tests still pass**

Run: `vp test run packages/void/test/unit/github-join-cmd.test.ts`
Expected: PASS (all existing tests, unchanged).

- [ ] **Step 3: Typecheck**

Run: `vp run --filter ./packages/void typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/void/src/cli/github-cmd.ts
git commit -m "refactor: extract performGithubJoin from runGithubJoin"
```

---

### Task 2: Auto-join fallback in `runConnect`

**Files:**

- Modify: `packages/void/src/cli/github-cmd.ts:500-539` (`runConnect` step 2)
- Test: `packages/void/test/unit/github-connect-cmd.test.ts`

**Interfaces:**

- Consumes: `performGithubJoin(client: PlatformClient): Promise<number>` from Task 1 (same file).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Extend the test harness for the join round-trip**

In `packages/void/test/unit/github-connect-cmd.test.ts`:

1. Add an `info` spy next to the existing log spies (both `beforeEach` and `afterEach`):

```ts
let infoSpy: ReturnType<typeof vi.spyOn>;
// beforeEach:
infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
// afterEach:
infoSpy.mockRestore();
```

2. Extend `driveConnect` so a test can drive the join round-trip. Add to its `opts` type:

```ts
listGithubInstallations?: ReturnType<typeof vi.fn>;
getGithubJoinUrl?: ReturnType<typeof vi.fn>;
completeGithubJoin?: ReturnType<typeof vi.fn>;
joinCallbackQuery?: (callbackUrl: URL) => URL;
```

Inside `driveConnect`, mirror the existing connect-authorize wiring for join (the join callback URL resolves the moment the command requests the join URL):

```ts
let resolveJoinCallback: ((url: URL) => void) | undefined;
const joinCallbackReady = new Promise<URL>((resolve) => {
  resolveJoinCallback = resolve;
});

const getGithubJoinUrl =
  opts.getGithubJoinUrl ??
  vi.fn(async (redirect: string) => {
    resolveJoinCallback?.(new URL(redirect));
    return { url: 'https://github.com/login/oauth/authorize?client_id=x' };
  });
const completeGithubJoin =
  opts.completeGithubJoin ?? vi.fn(async () => ({ status: 'joined', count: 0 }));
```

Add `listGithubInstallations: opts.listGithubInstallations ?? vi.fn(async () => [makeInstallation()])`, `getGithubJoinUrl`, and `completeGithubJoin` to the fake `client` object, and fire the join callback the same way the connect-authorize callback is fired:

```ts
const joinFired = opts.joinCallbackQuery
  ? joinCallbackReady.then(async (callbackUrl) => {
      const hit = opts.joinCallbackQuery!(callbackUrl);
      await originalFetch(hit).catch(() => {});
    })
  : Promise.resolve();
```

Chain it into the returned promise (`.finally(() => joinFired.catch(() => {}))`, alongside the existing `fired`) and return `getGithubJoinUrl`, `completeGithubJoin`, and `listGithubInstallations` from `driveConnect` so tests can assert on them.

- [ ] **Step 2: Write the failing tests**

Append a new `describe` block. `makeInstallation()` and `makeConnection()` already exist; `joined()` below is the standard join callback driver:

```ts
const joinCallback = (cb: URL) => {
  const hit = new URL(cb); // already carries the command's state
  hit.searchParams.set('join_code', 'jc-1');
  return hit;
};

describe('runConnect — auto-join fallback', () => {
  it('auto-joins and continues when the caller has no installations yet', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi
      .fn()
      .mockResolvedValueOnce([]) // before join
      .mockResolvedValueOnce([makeInstallation()]); // after join
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 1 }));
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise, getGithubJoinUrl } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' },
    });
    await promise;

    expect(getGithubJoinUrl).toHaveBeenCalledTimes(1);
    expect(completeGithubJoin).toHaveBeenCalledWith('jc-1', expect.any(String));
    expect(listGithubInstallations).toHaveBeenCalledTimes(2);
    expect(connectGithub).toHaveBeenCalledTimes(1);
  });

  it('errors with install-first guidance when auto-join finds nothing', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi.fn(async () => []);
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 0 }));
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'No GitHub App installation found for your account or your organizations. Run `void github install` first.',
    );
    expect(listGithubInstallations).toHaveBeenCalledTimes(1); // zero joined → no re-list
    expect(connectGithub).not.toHaveBeenCalled();
  });

  it('falls through to the install-first error when join OAuth is not configured (503)', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const listGithubInstallations = vi.fn(async () => []);
    const getGithubJoinUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new PlatformApiError(
          'Failed to get GitHub join URL',
          503,
          JSON.stringify({ error: 'github_oauth_not_configured' }),
        ),
      );
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      getGithubJoinUrl,
      args: { executor: 'container' },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(
      'No GitHub App installation found for your account or your organizations. Run `void github install` first.',
    );
    // The join-command-only copy must not leak into connect:
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Organization installation sharing is not enabled on this Void instance.',
    );
  });

  it('never starts the join round-trip without a TTY', async () => {
    // beforeEach already forces isTTY = false
    const listGithubInstallations = vi.fn(async () => []);
    const getGithubJoinUrl = vi.fn();
    const connectGithub = vi.fn();

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations,
      getGithubJoinUrl,
    });
    await expect(promise).rejects.toThrow('process.exit(1)');

    expect(getGithubJoinUrl).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      'No active GitHub App installation. Run `void github install` first, or `void github join` if your organization already installed the Void GitHub App.',
    );
  });

  it('recovers a missing --installation id via auto-join', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const other: GithubInstallation = {
      ...makeInstallation(),
      id: 'install_2',
      installation_id: '999999',
      account_login: 'someone-else',
    };
    const listGithubInstallations = vi
      .fn()
      .mockResolvedValueOnce([other]) // target missing
      .mockResolvedValueOnce([other, makeInstallation()]); // joined
    const completeGithubJoin = vi.fn(async () => ({ status: 'joined', count: 1 }));
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise, getGithubJoinUrl } = driveConnect({
      connectGithub,
      listGithubInstallations,
      completeGithubJoin,
      joinCallbackQuery: joinCallback,
      args: { executor: 'container' }, // baseArgs pins installationId = '123456'
    });
    await promise;

    expect(getGithubJoinUrl).toHaveBeenCalledTimes(1);
    expect(listGithubInstallations).toHaveBeenCalledTimes(2);
    expect(connectGithub).toHaveBeenCalledTimes(1);
  });
});
```

Also check this file for an existing test asserting the old copy `No active GitHub App installation. Run \`void github install\` first.` — if present, update it to the new non-TTY copy (the behavior it covers is now the non-TTY branch).

- [ ] **Step 3: Run tests to verify they fail**

Run: `vp test run packages/void/test/unit/github-connect-cmd.test.ts`
Expected: the new `auto-join fallback` tests FAIL (old error copy printed; `getGithubJoinUrl` never called).

- [ ] **Step 4: Implement the fallback**

In `runConnect`, replace step 2 (`github-cmd.ts:500-539`) with:

```ts
  // -------------------------------------------------------------------------
  // 2. Resolve installation
  // -------------------------------------------------------------------------
  const listActiveInstallations = async () =>
    (await client.listGithubInstallations()).filter((i) => i.status === 'active');

  // Auto-join fallback: an org member whose org already installed the App has
  // no membership row until a join round-trip records one, so their list is
  // empty (or missing the shared installation) even though the App is
  // installed. Run the join flow once instead of telling them to re-install.
  // Browser round-trips are TTY-only, mirroring every other prompt here. A 503
  // (sharing not configured) falls through to the install-first error.
  let autoJoinAttempted = false;
  const attemptAutoJoin = async (): Promise<number> => {
    autoJoinAttempted = true;
    try {
      return await performGithubJoin(client);
    } catch (err) {
      if (
        err instanceof PlatformApiError &&
        err.status === 503 &&
        err.code === 'github_oauth_not_configured'
      ) {
        return 0;
      }
      throw err;
    }
  };

  let installations = await listActiveInstallations();

  if (installations.length === 0 && isTTY) {
    log.info(
      'No GitHub App installation is linked to your account yet — checking whether your organization already installed the Void GitHub App…',
    );
    if ((await attemptAutoJoin()) > 0) {
      installations = await listActiveInstallations();
    }
  }

  if (installations.length === 0) {
    log.error(
      isTTY
        ? 'No GitHub App installation found for your account or your organizations. Run `void github install` first.'
        : 'No active GitHub App installation. Run `void github install` first, or `void github join` if your organization already installed the Void GitHub App.',
    );
    process.exit(1);
  }

  let installation: GithubInstallation;

  if (args.installationId) {
    let found = installations.find((i) => i.installation_id === args.installationId);
    if (!found && isTTY && !autoJoinAttempted) {
      log.info(
        `Installation '${args.installationId}' is not linked to your account yet — checking whether your organization shares it…`,
      );
      if ((await attemptAutoJoin()) > 0) {
        installations = await listActiveInstallations();
        found = installations.find((i) => i.installation_id === args.installationId);
      }
    }
    if (!found) {
      log.error(`connect: No active installation found with id '${args.installationId}'.`);
      process.exit(1);
    }
    installation = found;
  } else if (installations.length === 1) {
```

(The rest of step 2 — single-installation shortcut, non-TTY multi error, picker — is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `vp test run packages/void/test/unit/github-connect-cmd.test.ts`
Expected: PASS (new and pre-existing tests).

- [ ] **Step 6: Typecheck and commit**

Run: `vp run --filter ./packages/void typecheck` — expected clean.

```bash
git add packages/void/src/cli/github-cmd.ts packages/void/test/unit/github-connect-cmd.test.ts
git commit -m "feat: auto-join org installations during \`void github connect\`"
```

---

### Task 3: Member repo prompt — fix the redacted-repository dead-end

**Files:**

- Modify: `packages/void/src/cli/github-cmd.ts:544-596` (`runConnect` step 3)
- Test: `packages/void/test/unit/github-connect-cmd.test.ts`

**Interfaces:**

- Consumes: `parseGithubRepoFullName`, `collectGitDeployMetadata`, `text`, `isCancel`, `cancel` (all already imported in github-cmd.ts).
- Produces: module-private `promptRepoFullName(root: string): Promise<string>` used by both the `'all'` branch and the new `selected`+empty branch.

- [ ] **Step 1: Write the failing tests**

The repo prompt uses `@clack/prompts`' `text`, so the test file needs a partial module mock. At the top of `github-connect-cmd.test.ts` (next to the existing `node:child_process` mock), replace the plain clack import with:

```ts
const mockText = vi.fn();
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, text: (...args: Array<unknown>) => mockText(...args) };
});
```

(The existing `import { log } from '@clack/prompts'` and the `log` spies keep working — `log` passes through from the actual module.) Reset it in `beforeEach` with `mockText.mockReset()`. Existing tests never reach a `text` prompt (they pass `repo` and `branch` in args), so they are unaffected.

Append tests:

```ts
describe('runConnect — member repo prompt (redacted repository list)', () => {
  const memberInstallation = (): GithubInstallation => ({
    ...makeInstallation(),
    repositories: [], // server redacts the list for non-owner (member) rows
    repository_selection: 'selected',
  });

  it('prompts for owner/repo on a TTY instead of dead-ending', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    mockText.mockResolvedValueOnce(repoFullName); // user types octocat/hello-world
    const connectGithub = vi.fn().mockResolvedValueOnce(makeConnection());

    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations: vi.fn(async () => [memberInstallation()]),
      args: { executor: 'container', repo: undefined }, // no --repo
    });
    await promise;

    expect(mockText).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Repository (owner/repo):' }),
    );
    expect(connectGithub).toHaveBeenCalledTimes(1);
    // client.connectGithub(projectId, body) — body.repoFullName carries the typed repo
    const body = connectGithub.mock.calls[0]![1] as { repoFullName: string };
    expect(body.repoFullName).toBe(repoFullName);
  });

  it('fails closed without a TTY, naming --repo', async () => {
    const connectGithub = vi.fn();
    const { promise } = driveConnect({
      connectGithub,
      listGithubInstallations: vi.fn(async () => [memberInstallation()]),
      args: { repo: undefined },
    });
    await expect(promise).rejects.toThrow('process.exit(1)');
    expect(errorSpy).toHaveBeenCalledWith(
      'connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.',
    );
    expect(mockText).not.toHaveBeenCalled();
  });
});
```

(`connectGithub(projectId, body)` is the real signature — `packages/void/src/cli/client.ts:972-983`; `body.repoFullName` is where the typed repo lands.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `vp test run packages/void/test/unit/github-connect-cmd.test.ts`
Expected: new tests FAIL — TTY case exits with `The installation has no accessible repositories…`, non-TTY case prints that same old copy instead of the new `--repo` copy.

- [ ] **Step 3: Implement**

Add the helper above `runConnect` (module-private):

```ts
/**
 * Free-text repository prompt used when the installation's repository list is
 * not enumerable client-side: `repository_selection === 'all'`, or a shared
 * org installation whose list the server redacts for non-owner members. The
 * server re-verifies actual access on connect, so this is DX, not security.
 */
async function promptRepoFullName(root: string): Promise<string> {
  const gitDefault = parseGithubRepoFullName(collectGitDeployMetadata(root, null).repositoryUrl);
  const input = await text({
    message: 'Repository (owner/repo):',
    placeholder: gitDefault ?? 'owner/repo',
    initialValue: gitDefault ?? '',
    validate: (value) =>
      /^[^/\s]+\/[^/\s]+$/.test((value ?? '').trim())
        ? undefined
        : 'Enter the repository as owner/repo.',
  });
  if (isCancel(input)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return (input as string).trim();
}
```

Rewrite step 3's `selected` branch (`:548-569`) so the empty-list case prompts on a TTY, and the `'all'` branch (`:570-596`) uses the same helper:

```ts
  } else if (installation.repository_selection === 'selected') {
    if (installation.repositories.length === 0) {
      // The server redacts `repositories` to [] for non-owner (member) rows of
      // shared org installations, and an owner install can genuinely have zero
      // grants. Either way the list is not enumerable here — take free text
      // and let the server's access check decide.
      if (!isTTY) {
        log.error(
          'connect: --repo <owner/repo> is required — this installation does not expose a repository list to your account.',
        );
        process.exit(1);
      }
      repoFullName = await promptRepoFullName(root);
    } else if (installation.repositories.length === 1) {
      repoFullName = installation.repositories[0]!.full_name;
    } else if (!isTTY) {
      log.error('connect: Multiple repositories available. Pass --repo <owner/repo>.');
      process.exit(1);
    } else {
      const picked = await select({
        message: 'Select a repository:',
        options: installation.repositories.map((r) => ({ value: r.full_name, label: r.full_name })),
      });
      if (isCancel(picked)) {
        cancel('Cancelled.');
        process.exit(0);
      }
      repoFullName = picked as string;
    }
  } else {
    // 'all' — repos aren't enumerable. Do NOT infer the repo from git in CI:
    // GITHUB_REPOSITORY / origin can point at a fork or the wrong checkout and
    // would silently bind the project to the wrong repo. Require --repo, the
    // same way --branch is required in non-interactive mode.
    if (!isTTY) {
      log.error(
        'connect: --repo <owner/repo> is required in non-interactive mode for an all-repositories installation.',
      );
      process.exit(1);
    }
    repoFullName = await promptRepoFullName(root);
  }
```

The `'all'` branch's old inline prompt (and its `connect: Repository is required.` empty-check, now covered by `validate`) is deleted. If any existing test asserts `connect: Repository is required.`, update it to expect the `validate` rejection instead (check with a grep before assuming).

- [ ] **Step 4: Run tests to verify they pass**

Run: `vp test run packages/void/test/unit/github-connect-cmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `vp run --filter ./packages/void typecheck` — expected clean.

```bash
git add packages/void/src/cli/github-cmd.ts packages/void/test/unit/github-connect-cmd.test.ts
git commit -m "fix: prompt for owner/repo when a shared installation hides its repository list"
```

---

### Task 4: Docs

**Files:**

- Modify: `docs/reference/cli.md` (sections `### void github join` ~line 604 and `### void github connect` ~lines 614-639)

**Interfaces:** none.

- [ ] **Step 1: Update `docs/reference/cli.md`**

1. In the `### void github connect` section, after the paragraph describing what connect does, add:

> If your account has no installations yet, `void github connect` first runs the same browser authorize as `void github join` automatically — if a teammate already installed the Void GitHub App on your organization, you join it on the spot and the connect continues. Only when no shared installation is found does it ask you to run `void github install`. The same recovery runs when `--installation <id>` names an installation your account is not linked to yet.

2. In the non-TTY paragraph (~line 639, "When stdin is not a TTY, `void github connect` never prompts…"), append to the `--repo` sentence:

> `--repo` is also required when the installation does not expose a repository list to your account (shared org installations hide it).

3. In the `### void github join` section (~line 610), append:

> You rarely need to run this yourself: `void github connect` runs the same join automatically when your account has no installations yet.

4. Grep `packages/void/AGENT_PROMPT.md` and `packages/void/getting-started-prompt.txt` for `github install` / `github join` / `github connect` — as of planning they have no such references, so expect no changes; update only if a stale instruction turns up. Do not touch `packages/void/skills/void/docs` (gitignored, auto-copied at build).

- [ ] **Step 2: Commit**

```bash
git add docs/reference/cli.md
git commit -m "docs: describe github connect auto-join fallback"
```

---

### Final verification (after all tasks)

- [ ] Run: `vp test run packages/void` — expected: full package suite PASS.
- [ ] Run: `vp run check` — expected: clean typecheck across packages.
