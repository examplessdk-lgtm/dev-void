import { join } from 'pathe';
import type { Plugin } from 'vite';
import { scanJobsSync } from './crons/scan.ts';
import { voidLog } from './log.ts';
import { scanQueuesSync } from './queues/scan.ts';
import { parseDotenvFile } from './shared/dotenv.ts';

/**
 * Prints a one-shot hint on dev server start when the project has crons
 * or queues, explaining how to trigger them locally. Both default Void mode
 * and framework mode (SvelteKit, Nuxt, Astro, TanStack Start, React Router,
 * vinext) expose `/__void/scheduled` and `/__void/queue`. Analog support is
 * pending.
 */
export function devTriggersHintPlugin(
  root: string,
  options: { framework: boolean; devTriggerToken: string },
): Plugin {
  const { devTriggerToken } = options;
  return {
    name: 'void:dev-triggers-hint',
    apply: 'serve',
    configureServer(server) {
      const jobs = scanJobsSync(root);
      const queues = scanQueuesSync(root);
      if (jobs.length === 0 && queues.length === 0) {
        return;
      }

      const afterReady = (fn: () => void) => {
        if (server.httpServer) {
          server.httpServer.once('listening', () => setTimeout(fn, 100));
        } else {
          fn();
        }
      };

      afterReady(() => {
        const address = server.httpServer?.address();
        const port = typeof address === 'object' && address ? address.port : null;
        if (port == null) {
          return;
        }
        const baseUrl = `http://localhost:${port}`;

        const summary: Array<string> = [];
        if (jobs.length > 0) {
          summary.push(`${jobs.length} cron${jobs.length === 1 ? '' : 's'}`);
        }
        if (queues.length > 0) {
          summary.push(`${queues.length} queue${queues.length === 1 ? '' : 's'}`);
        }

        console.log();
        voidLog(`Detected ${summary.join(' and ')}. Trigger locally:`);
        // `__VOID_PROXY_TOKEN` is the platform's prod handshake header, mirrored
        // locally via `.dev.vars` (which @cloudflare/vite-plugin populates into
        // worker bindings). Other env sources are intentionally NOT considered:
        // `.env`/process.env entries are stripped by `stripInternalEnvKeys` on
        // the Void path, and wrangler `[vars]` go through the CF plugin which
        // also surfaces them via the worker env — but that's a deploy-config
        // path, not a dev-trigger ergonomics one. `.dev.vars` is the single
        // place a developer is expected to define this token, so it's the
        // single source we consult here to keep hint and dispatcher in sync.
        const configuredProxyToken = parseDotenvFile(join(root, '.dev.vars'), {
          expand: false,
        }).__VOID_PROXY_TOKEN;
        const authHeader = configuredProxyToken
          ? `x-void-internal: ${configuredProxyToken}`
          : `x-void-dev-trigger: ${devTriggerToken}`;

        if (jobs.length > 0) {
          const sample = jobs[0].crons[0];
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/scheduled \\\n           -H "${authHeader}" \\\n           -d '{"cron":"${sample}","scheduledTime":'"$(date +%s000)"'}'\x1b[22m`,
          );
        }
        if (queues.length > 0) {
          const sample = queues[0].name;
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/queue \\\n           -H "${authHeader}" \\\n           -d '{"queue":"${sample}","messages":[{"id":"1","timestamp":'"$(date +%s000)"',"body":{},"attempts":1}]}'\x1b[22m`,
          );
        }
      });
    },
  };
}
