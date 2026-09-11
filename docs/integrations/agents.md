---
outline: deep
---

# Using Void with Coding Agents

Void integrates with coding agents via **skills** that provide agent instructions and reference docs. They are set up as part of the default `void init` flow. To run only the agent setup step:

```sh
npx void init --agents
```

This detects your coding agent, links skills into its configuration directory, and injects a Void reference block into your agent instructions file (`CLAUDE.md` or `AGENTS.md`). If auto-detection fails, it asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

## Skills

Skills give your coding agent structured knowledge about Void, including how to use the CLI, build apps, work with routes, databases, auth, and more. They are symlinked from the `void` package into the agent's skills directory, so they stay version-matched with your installed Void version.

Void ships two skills:

- **`void`:** main development skill. Routes agent requests to the right documentation for CLI commands, routing, pages, database, auth, deployment, and more.
- **`migrate-vite-cloudflare-to-void`:** migration skill for converting existing `@cloudflare/vite-plugin` apps to Void.

Skills are linked automatically by `void init --agents`. For Claude Code, they are symlinked into `.claude/skills/`. Other agents that support skills will have them linked to their respective directories.
