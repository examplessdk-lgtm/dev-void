import type { Plugin } from 'vite';
import { scanJobsSync } from './crons/scan.ts';
import { voidLog, voidWarn } from './log.ts';
import { scanQueuesSync } from './queues/scan.ts';

/**
 * Prints a one-shot hint on dev server start when the project has crons
 * or queues, explaining how (and whether) to trigger them locally.
 *
 * - Default Void mode: points at the `/__void/scheduled` and `/__void/queue`
 *   endpoints registered by the routing plugin.
 * - Framework mode (Class B/C): notes that dev triggering is not yet wired
 *   up, since the wrapper that exposes those endpoints only runs at deploy.
 */
export function devTriggersHintPlugin(root: string, options: { framework: boolean }): Plugin {
  const { framework } = options;
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
        if (port == null && !framework) {
          return;
        }
        const baseUrl = `http://localhost:${port ?? 5173}`;

        const summary: Array<string> = [];
        if (jobs.length > 0) {
          summary.push(`${jobs.length} cron${jobs.length === 1 ? '' : 's'}`);
        }
        if (queues.length > 0) {
          summary.push(`${queues.length} queue${queues.length === 1 ? '' : 's'}`);
        }

        console.log();
        if (framework) {
          voidWarn(
            `Detected ${summary.join(' and ')} — dev triggering is not yet supported in framework mode.`,
          );
          voidWarn('Deploy with `void deploy` to test, or import handlers from a route.');
          return;
        }

        voidLog(`Detected ${summary.join(' and ')}. Trigger locally:`);
        if (jobs.length > 0) {
          const sample = jobs[0].crons[0];
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/scheduled \\\n           -H "x-void-internal: $__VOID_PROXY_TOKEN" \\\n           -d '{"cron":"${sample}","scheduledTime":'"$(date +%s000)"'}'\x1b[22m`,
          );
        }
        if (queues.length > 0) {
          const sample = queues[0].name;
          console.log(
            `         \x1b[2mcurl -X POST ${baseUrl}/__void/queue \\\n           -H "x-void-internal: $__VOID_PROXY_TOKEN" \\\n           -d '{"queue":"${sample}","messages":[{"id":"1","timestamp":'"$(date +%s000)"',"body":{},"attempts":1}]}'\x1b[22m`,
          );
        }
      });
    },
  };
}
