/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Heading } from '@astryxdesign/core/Text';
import type { PlatformLifecycleOperation } from '@void/platform';
import { useEffect, useState } from 'react';
import type { PlatformStatusSnapshot } from '../../platform-status.ts';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';

const PHASE_LABELS: Record<PlatformLifecycleOperation['phase'], string> = {
  preparing: 'Preparing the platform',
  deploying: 'Deploying services',
  verifying: 'Verifying the platform',
  enabling: 'Enabling traffic and verifying cutover',
  'waiting-for-dns': 'Waiting for DNS',
  'waiting-for-sandbox-drain': 'Waiting for Sandbox drain',
  complete: 'Operation complete',
  failed: 'Operation needs attention',
};
const ACTION_LABELS: Record<PlatformLifecycleOperation['action'], string> = {
  install: 'Installation',
  upgrade: 'Upgrade',
  rollback: 'Rollback',
  repair: 'Repair',
  enable: 'Enable',
};

export function PlatformStatusPage({
  platformName,
  username,
  snapshot,
}: {
  platformName: string;
  username?: string;
  snapshot: PlatformStatusSnapshot | null;
}) {
  const [current, setCurrent] = useState(snapshot);
  const [connection, setConnection] = useState<'current' | 'unavailable' | 'expired'>(
    snapshot ? 'current' : 'unavailable',
  );
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 5000);
        return;
      }
      try {
        const response = await fetch('/admin/status.json', {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        });
        if (stopped) {
          return;
        }
        if (response.redirected || response.status === 401 || response.status === 403) {
          setConnection('expired');
          return;
        }
        if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) {
          throw new Error('Status unavailable');
        }
        const next: PlatformStatusSnapshot = await response.json();
        if (stopped) {
          return;
        }
        setCurrent(next);
        setConnection('current');
      } catch {
        if (stopped) {
          return;
        }
        setConnection('unavailable');
      }
      if (!stopped) {
        timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  const operation = current?.checkpoint?.operation;
  const waiting =
    operation?.phase === 'waiting-for-dns' || operation?.phase === 'waiting-for-sandbox-drain';
  const failed =
    operation?.phase === 'failed' ||
    (current?.checkpoint?.status === 'failed' && (!operation || operation.phase === 'complete'));
  const needsAttention = failed || waiting;
  const trafficLabel = !current
    ? 'Unknown'
    : current.traffic === 'paused'
      ? 'Traffic paused'
      : 'Traffic enabled';
  const phaseLabel = failed
    ? 'Operation needs attention'
    : operation
      ? PHASE_LABELS[operation.phase]
      : current?.checkpoint
        ? `Saved installation state: ${current.checkpoint.status}`
        : 'No saved operation';

  return (
    <Layout platformName={platformName} username={username} title="Platform status">
      <div className="void-platform-status">
        <div className="void-platform-status-heading">
          <div>
            <Heading level={1}>Platform status</Heading>
            <p>Follow upgrade and rollback progress. This page is read-only during maintenance.</p>
          </div>
          <button
            type="button"
            className="void-platform-status-refresh"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh status
          </button>
        </div>

        <div className="void-platform-status-notice" role="status" aria-live="polite">
          {connection === 'expired' ? (
            <p>
              Your administrator session needs attention. <a href="/admin/login">Sign in again</a>{' '}
              to confirm the current status.
            </p>
          ) : connection === 'unavailable' ? (
            <p>
              Live status is unavailable.{' '}
              {current
                ? 'Showing the last confirmed snapshot; it may be out of date.'
                : 'The current operation and traffic state could not be confirmed.'}{' '}
              Progress is saved independently of this page.
            </p>
          ) : (
            <p>
              Updates every 5 seconds while this page is visible. A saved checkpoint may remain
              unchanged while a phase runs.
            </p>
          )}
        </div>

        <div className="void-platform-status-grid">
          <section
            className="void-platform-status-card"
            aria-labelledby="platform-operation-heading"
          >
            <span className="void-platform-status-eyebrow">
              {operation ? ACTION_LABELS[operation.action] : 'Lifecycle'}
            </span>
            <Heading level={2} id="platform-operation-heading">
              {phaseLabel}
            </Heading>
            {operation ? (
              <>
                <p className="void-platform-status-version">
                  {operation.fromVersion ?? 'New installation'} <span aria-label="to">→</span>{' '}
                  {operation.toVersion}
                </p>
                <dl>
                  <dt>Started</dt>
                  <dd>{formatDateTime(operation.startedAt)}</dd>
                  <dt>Progress saved</dt>
                  <dd>{formatDateTime(operation.updatedAt)}</dd>
                  <dt>Installation state</dt>
                  <dd>{current?.checkpoint?.status}</dd>
                </dl>
              </>
            ) : (
              <p>
                {current?.checkpoint
                  ? `Saved runtime: ${current.checkpoint.platformVersion}. This operation has no detailed progress record.`
                  : 'Detailed progress is available for installations managed by the Void lifecycle CLI.'}
              </p>
            )}
            {operation?.phase === 'complete' && !failed && (
              <p>
                The lifecycle operation completed. Use the traffic state alongside health checks to
                assess availability.
              </p>
            )}
            {operation && !needsAttention && operation.phase !== 'complete' && (
              <p>
                Keep the lifecycle command running. Refreshing this page does not interrupt the
                operation.
              </p>
            )}
          </section>

          <section className="void-platform-status-card" aria-labelledby="platform-traffic-heading">
            <span className="void-platform-status-eyebrow">Traffic state reported by the API</span>
            <Heading level={2} id="platform-traffic-heading">
              {trafficLabel}
              {current && connection !== 'current' ? ' (last confirmed)' : ''}
            </Heading>
            <p>
              {!current
                ? 'Traffic state is not currently available.'
                : current.traffic === 'paused'
                  ? 'Application requests may receive a temporary-unavailability response. Platform changes stay paused for administrators except for sign-in and this status page.'
                  : 'The API traffic gate is open. Individual projects and other services may still be affected while Workers roll out.'}
            </p>
            {current && (
              <p className="void-platform-status-timestamp">
                Confirmed {formatDateTime(current.checkedAt)}
              </p>
            )}
            <p>This state does not replace service or project health checks.</p>
          </section>
        </div>

        {needsAttention && (
          <section
            className="void-platform-status-card void-platform-status-recovery"
            aria-labelledby="platform-recovery-heading"
          >
            <Heading level={2} id="platform-recovery-heading">
              Next step
            </Heading>
            <p>
              {operation?.phase === 'waiting-for-dns'
                ? 'Wait for the zone to become active, then rerun the lifecycle command.'
                : operation?.phase === 'waiting-for-sandbox-drain'
                  ? 'Complete the remaining Sandbox drain work using the CLI, then rerun the lifecycle command. Traffic stays paused until the cutover is verified.'
                  : 'Review the CLI error and saved installation state. Resolve the error before resuming the same lifecycle command.'}
            </p>
            <p>
              Use the recovery commands printed by the CLI and keep the same runtime files
              {operation?.action === 'rollback' ? ', including the rollback source runtime' : ''}.
              Reloading this page does not resume an operation.
            </p>
          </section>
        )}
        {current?.traffic === 'enabled' && connection === 'current' && (
          <p>
            <a href="/admin/">Return to dashboard</a>
          </p>
        )}
      </div>
    </Layout>
  );
}
