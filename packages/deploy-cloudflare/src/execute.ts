export type CloudflareCommandResult = {
  stdout: string;
  stderr: string;
  status: number;
  signal?: NodeJS.Signals | null;
  error?: string | null;
};

export type CloudflareCommandRunner = (
  args: Array<string>,
  options: { capture: boolean },
) => CloudflareCommandResult | Promise<CloudflareCommandResult>;

export type CloudflareDeployExecution =
  | { ok: true }
  | { ok: false; reason: 'uploader-changed' }
  | { ok: false; reason: 'deploy-failed'; status: number };

/** Upload the already-verified Worker artifact without Wrangler autoconfiguration. */
export async function executeCloudflareDeploy(options: {
  runWrangler: CloudflareCommandRunner;
  verifyUploader: () => boolean;
  configPath?: string;
}): Promise<CloudflareDeployExecution> {
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }

  const result = await Promise.resolve(
    options.runWrangler(
      [
        'deploy',
        ...(options.configPath ? ['-c', options.configPath] : []),
        '--env=',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: false },
    ),
  );
  if (!isCleanCommandExit(result)) {
    return { ok: false, reason: 'deploy-failed', status: result.status };
  }
  return { ok: true };
}

function isCleanCommandExit(result: CloudflareCommandResult): boolean {
  return (
    result.status === 0 && result.signal == null && (result.error == null || result.error === '')
  );
}
