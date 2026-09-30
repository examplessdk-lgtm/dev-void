/** @jsxImportSource react */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';

type ProjectZeroTrust = Readonly<{
  configured: boolean;
  invalid: boolean;
  enabled: boolean;
  status: string | null;
  operation: string | null;
  available: boolean;
  state: Readonly<{
    desired_protected: boolean;
    effective_protected: boolean;
    state: string;
    last_error: string | null;
  }> | null;
}>;

const REVIEW = '/admin/zero-trust';

function protection(value: boolean | undefined): string {
  return value === undefined ? 'not initialized' : value ? 'protected' : 'public';
}

function statusLabel(status: string): string {
  return status === 'error' ? 'needs attention' : status;
}

function platformLabel(zeroTrust: ProjectZeroTrust): string {
  if (zeroTrust.invalid) {
    return 'invalid configuration';
  }
  if (!zeroTrust.configured) {
    return 'not configured';
  }
  const enabled = zeroTrust.enabled ? 'enabled' : 'disabled';
  return zeroTrust.status && zeroTrust.status !== 'ready'
    ? `${enabled}, ${statusLabel(zeroTrust.status)}`
    : enabled;
}

function unavailableReason(zeroTrust: ProjectZeroTrust) {
  if (zeroTrust.invalid) {
    return (
      <>
        The saved Zero Trust configuration is invalid. <a href={REVIEW}>Review it</a>.
      </>
    );
  }
  if (!zeroTrust.configured || (!zeroTrust.enabled && !zeroTrust.operation)) {
    return (
      <>
        Project Zero Trust is not enabled. <a href={REVIEW}>Configure it</a>.
      </>
    );
  }
  if (zeroTrust.operation) {
    return (
      <>
        A Zero Trust {zeroTrust.operation} operation is running. Project changes are available after
        it finishes. <a href={REVIEW}>View status</a>.
      </>
    );
  }
  return (
    <>
      Platform Zero Trust status: {zeroTrust.status ? statusLabel(zeroTrust.status) : 'not ready'}.{' '}
      <a href={REVIEW}>Review it</a>.
    </>
  );
}

export function ProjectZeroTrustSection({
  projectId,
  zeroTrust,
}: {
  projectId: string;
  zeroTrust: ProjectZeroTrust;
}) {
  const { state } = zeroTrust;
  return (
    <section id="zero-trust" className="void-admin-project-zero-trust">
      <h2>Zero Trust</h2>
      <div className="void-admin-project-zero-trust-state">
        <span>Platform: {platformLabel(zeroTrust)}</span>
        {(state !== null || zeroTrust.enabled) && (
          <>
            <span>Desired: {protection(state?.desired_protected)}</span>
            <span>Effective: {protection(state?.effective_protected)}</span>
            <Badge
              label={state?.state ?? 'not initialized'}
              variant={
                state?.state === 'error'
                  ? 'error'
                  : state?.state === 'reconciling'
                    ? 'info'
                    : state?.state === 'protected'
                      ? 'success'
                      : 'neutral'
              }
            />
          </>
        )}
      </div>
      {state?.last_error && (
        <Banner status="error" title="Last error" description={state.last_error} />
      )}
      {zeroTrust.available ? (
        <div className="void-admin-team-actions">
          <form
            method="post"
            action={`/admin/projects/${projectId}/zero-trust`}
            {...(state?.desired_protected
              ? {
                  'data-confirm':
                    'Make this project public? Anyone can reach its hostnames without signing in.',
                }
              : {})}
          >
            <input
              type="hidden"
              name="protected"
              value={state?.desired_protected ? 'false' : 'true'}
            />
            <Button
              type="submit"
              label={state?.desired_protected ? 'Make project public' : 'Protect project'}
              variant={state?.desired_protected ? 'destructive' : 'primary'}
            />
          </form>
          <form method="post" action={`/admin/projects/${projectId}/zero-trust/reconcile`}>
            <Button type="submit" label="Reconcile" variant="secondary" />
          </form>
        </div>
      ) : (
        <p>{unavailableReason(zeroTrust)}</p>
      )}
    </section>
  );
}
