# Former repository split

**Date:** 2026-02-22
**Status:** Superseded by the unified repository.

This document originally planned separate framework and platform repositories.
That layout no longer applies. The framework and CLI now live in `packages/`,
and the platform implementation lives in `platform/packages/`, in one workspace
with shared contracts and tests. There is no framework submodule to update.

The original plan remains in Git history. This path is retained for historical
references; use the [platform architecture](../architecture.md) and
[self-hosted platform guide](../../../docs/guide/self-hosted-platform.md) for
the current layout and installation workflow.
