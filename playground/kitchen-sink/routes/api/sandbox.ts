import { defineHandler } from 'void';
import { getSandbox } from 'void/sandbox';
import { sampleRequests } from '../../lib/sandbox-demo.ts';

const MAX_CODE_LENGTH = 8_000;
const WORKDIR = '/workspace/void-kitchen-sink-code-lab';

const RUNNER = `import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const codeUrl = pathToFileURL("./user-code.mjs").href + "?t=" + Date.now();
const mod = await import(codeUrl);

if (typeof mod.default !== "function") {
  throw new Error("Expected user-code.mjs to export a default function.");
}

const input = JSON.parse(await readFile("./input.json", "utf8"));
const startedAt = Date.now();
const value = await mod.default(input.requests);
const output = {
  value,
  elapsedMs: Date.now() - startedAt,
};

await writeFile("./output.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
`;

export const POST = defineHandler(async (c) => {
  const body = await c.req.json<{ code?: unknown }>().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : '';

  if (!code.trim()) {
    return c.json({ ok: false, error: 'Code is required.' }, 400);
  }

  if (code.length > MAX_CODE_LENGTH) {
    return c.json(
      {
        ok: false,
        error: `Code must be ${MAX_CODE_LENGTH.toLocaleString()} characters or less.`,
      },
      400,
    );
  }

  const sandbox = getSandbox('kitchen-sink-code-lab');

  try {
    await sandbox.mkdir(WORKDIR, { recursive: true });
    await sandbox.writeFile(
      `${WORKDIR}/input.json`,
      JSON.stringify({ requests: sampleRequests }, null, 2),
    );
    await sandbox.writeFile(`${WORKDIR}/user-code.mjs`, code);
    await sandbox.writeFile(`${WORKDIR}/run.mjs`, RUNNER);

    const result = await sandbox.exec('node run.mjs', {
      cwd: WORKDIR,
      timeout: 5_000,
      env: {
        NODE_OPTIONS: '--disable-proto=throw',
      },
    });

    let output: unknown = null;
    if (result.success) {
      const file = await sandbox.readFile(`${WORKDIR}/output.json`, { encoding: 'utf-8' });
      output = JSON.parse(file.content);
    }

    return c.json({
      ok: result.success,
      output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: result.duration,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: message }, 500);
  }
});
