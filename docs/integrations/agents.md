---
outline: deep
---

# Using Void with Coding Agents

`void init` gives your coding agent Void instructions and reference docs. To add or refresh just that setup, run:

```sh
npx void init --agents
```

This detects your coding agent, links skills into its configuration directory, and injects a Void reference block into your agent instructions file (`CLAUDE.md` or `AGENTS.md`). If auto-detection fails, it asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

## Skills

Skills point your agent to the commands and docs it needs for the task. They link to the installed `void` package, so the guidance matches the version your app uses.

Void ships two skills:

- **`void`:** main development skill. Routes agent requests to the right documentation for CLI commands, routing, pages, database, auth, deployment, and more.
- **`migrate-vite-cloudflare-to-void`:** migration skill for converting existing `@cloudflare/vite-plugin` apps to Void.

Skills are linked automatically by `void init --agents`. For Claude Code, they are symlinked into `.claude/skills/`. Other agents that support skills will have them linked to their respective directories.
