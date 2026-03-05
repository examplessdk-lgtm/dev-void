import { execSync } from "node:child_process";
import { log } from "@clack/prompts";
import type { AuthArgs } from "./auth-args";
import { getToken, removeToken } from "./auth";
import { PlatformClient } from "./client";
import { runLoginCommand } from "./login";

export async function runAuthCommand(_root: string, args: AuthArgs): Promise<void> {
  switch (args.subcommand) {
    case "login":
      return runLoginCommand();
    case "logout":
      if (removeToken()) {
        log.success("Logged out.");
      } else {
        log.info("Not logged in.");
      }
      return;
    case "whoami": {
      const token = getToken();
      if (!token) {
        log.error("Not logged in. Run `void auth login` first.");
        process.exit(1);
      }
      const client = new PlatformClient(token);
      const user = await client.whoami();
      log.info(`${user.login} (${user.plan})`);
      return;
    }
    case "token": {
      if (!getToken()) {
        await runLoginCommand();
      }
      const token = getToken();
      if (!token) {
        log.error("Login failed. Run `void auth login` to try again.");
        process.exit(1);
      }
      const platform = process.platform;
      const cmd =
        platform === "darwin"
          ? "pbcopy"
          : platform === "win32"
            ? "clip"
            : "xclip -selection clipboard";
      try {
        execSync(cmd, { input: token });
        log.success("Token copied to clipboard.");
      } catch {
        log.warn("Could not copy to clipboard. Re-run `void login` to generate a new token.");
      }
      return;
    }
  }
}
