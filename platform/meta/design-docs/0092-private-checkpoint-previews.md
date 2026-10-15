# Private checkpoint previews

Connected applications can request `profile preview:deploy`. Administrators
enable the permission per client; users explicitly consent to it. Existing
grants remain profile-only. Publishing continues to require individual artifact
approval through `deploy:approve`.

Each (client, owner, external workspace) has a separate preview project, with
its own bindings and no production secrets. Builds use the existing prepared
artifact, verified uploads, revocable deployment receipt, queue, cutover fence,
and retained deployment cleanup. Preview authorization is checked again during
queued execution and cutover. It cannot target a production project.

Preview routing uses a separate `preview:` KV namespace, including replay and
rollback. Older dispatchers cannot resolve these keys and fail closed. The
installer stages the first upgrade and refuses incompatible runtime downgrades.
Each preview has a distinct origin. Its ingress forwards to the API, which
exchanges a one-use launch ticket for a host-only HttpOnly cookie and checks the
live user grant on every request. It strips platform credentials before calling
the dispatcher's service-only preview entrypoint. The public dispatcher rejects
preview routes. Cross-owner/client access, disabled clients, revoked grants,
expired sessions, and suspended users fail closed. Preview cookies and launch
tickets never reach generated code. Responses are private and uncacheable at
the browser authorization boundary.

Preview projects count toward resource/usage limits. Workspace creation is
bounded and serialized per owner; updates are rate limited. Initial support is
HTTP apps using isolated D1, KV, R2, AI, and native Durable Objects. Email,
scheduled/queue background work, externally supplied databases, and containers
require explicit production publishing instead. Inactive preview projects
expire and use the existing project teardown pipeline, including resources.

VibeZero builds checkpoints asynchronously and coalesces pending changes. The
last successful preview remains visible through builds and failures. Opening
an existing app fetches its ready preview without starting a sandbox. Initial
builds still take time; build/update latency and ready-preview opening latency
are measured separately. Production publishing remains an explicit action.

Verification includes focused OAuth and dispatch authorization tests, queued
revocation/cutover tests, failure/retention and isolation checks, affected
integration tests and typechecking, followed by the full repository suite.
Live E2E tests measure ready-preview opening separately from checkpoint builds
and verify that the opening path makes no editing-sandbox calls.
