# Shared terminal demos

`HomeCli.vue` and the local [capture studio](../../../../test/terminal-demos/README.md) use this player, timeline, and transcript data. The three workflows originate in commit `7eea677271f5bbabd5123112bbfeb74640d9fd4f`, with subsequent transcript corrections retained.

`TerminalPlayer.vue` defaults to studio chrome. The homepage uses `appearance="home"` with the theme's Vite+ background and command tabs. It provides pause/replay, stops automatic tab changes after a visitor selects a command, and supplies a static transcript for assistive technology. Reduced motion shows the final frame until playback is explicitly requested.

Update transcript wording in `demos.ts` for both surfaces together. Keep the sample values, prepared setup, and condensed timings described in the capture studio README; these examples do not execute CLI commands.

Run `node --test test/terminal-demos/timeline.test.ts`, `vp run build:docs`, and `vp build --config test/terminal-demos/vite.config.ts`. Check all three flows in the browser, including keyboard selection, pause/replay, narrow screens, and reduced motion.
