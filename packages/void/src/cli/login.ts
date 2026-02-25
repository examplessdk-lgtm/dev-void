import { intro, outro, log, spinner, select, isCancel, cancel } from "@clack/prompts";

import { getToken, runLogin, saveToken, isStagingMode } from "./auth";
import { cliTitle } from "./output";

export async function runLoginCommand(): Promise<void> {
  console.log();
  intro(cliTitle("login"));

  const existing = getToken();
  if (existing) {
    log.warn("Already logged in.");
    outro("To re-login, run `void logout` first.");
    return;
  }

  const provider = await select({
    message: "Choose a login provider:",
    options: [
      { value: "github", label: "GitHub" },
      { value: "google", label: "Google" },
    ],
  });

  if (isCancel(provider)) {
    cancel("Login cancelled.");
    process.exit(0);
  }

  const providerName = provider === "github" ? "GitHub" : "Google";
  const s = spinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const token = await runLogin(provider);
    saveToken(token);
    s.stop("Logged in!");
    outro(
      isStagingMode()
        ? "Staging token saved to ~/.void/config.json"
        : "Token saved to ~/.void/config.json",
    );
  } catch (err) {
    s.stop("Login failed");
    throw err;
  }
}
