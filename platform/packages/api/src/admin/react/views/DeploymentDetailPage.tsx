/** @jsxImportSource @voidcloud/api/admin-jsx */

import { Button } from '@astryxdesign/core/Button';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from '@astryxdesign/core/Table';
import { useRequest, useView } from 'react-fate';
import type { DeployManifest } from '../../../types.ts';
import { DeploymentDetailView, deploymentDetailRequest } from '../../fate/views.ts';
import { type AdminPageProps } from '../page-utils.ts';
import { CopyButton } from './CopyButton.tsx';
import { DeploymentLogs } from './DeploymentLogs.tsx';
import { displayStatus } from './DeploymentTable.tsx';
import { formatDateTime } from './format.ts';
import { Layout } from './Layout.tsx';

export function DeploymentDetailPage({ path, platformName, username }: AdminPageProps) {
  const { deploymentDetail: ref } = useRequest(deploymentDetailRequest(path), {
    mode: 'stale-while-revalidate',
  });
  const pageData = useView(DeploymentDetailView, ref);
  if (!pageData) {
    throw new Error('Deployment data is unavailable.');
  }
  const { deployment, project, canCancel, tz } = pageData;
  const manifest = pageData.manifest as DeployManifest | null;
  const status = displayStatus(deployment, project?.active_deployment_id);
  const statusStyle =
    status === 'live'
      ? { color: '#16a34a', fontWeight: 600 }
      : status === 'retained'
        ? { color: '#16a34a' }
        : status === 'evicted'
          ? { color: '#888' }
          : status === 'failed'
            ? { color: '#dc2626' }
            : undefined;
  return (
    <Layout platformName={platformName} title={`Deployment ${deployment.id}`} username={username}>
      <h1>Deployment {deployment.id}</h1>

      {canCancel && (
        <>
          <h2>Deploy Control</h2>
          <form
            method="post"
            action={`/admin/deployments/${deployment.id}/cancel`}
            data-confirm={`Cancel deployment "${deployment.id}"?`}
          >
            <Button type="submit" label="Cancel Deploy" variant="destructive" />
          </form>
        </>
      )}

      {(deployment.status === 'failed' || deployment.status === 'canceled') &&
        deployment.error_message && (
          <>
            <h2>Error</h2>
            <pre>{deployment.error_message}</pre>
            <p>
              <CopyButton text={deployment.error_message} label="Copy error" />
            </p>
          </>
        )}

      <Table>
        <TableBody>
          <TableRow>
            <TableHeaderCell>ID</TableHeaderCell>
            <TableCell>{deployment.id}</TableCell>
            <TableHeaderCell>Project</TableHeaderCell>
            <TableCell>
              {project ? (
                <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
              ) : (
                deployment.project_id
              )}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableCell style={statusStyle}>{status}</TableCell>
            <TableHeaderCell>Source</TableHeaderCell>
            <TableCell>{deployment.source ?? '-'}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Commit</TableHeaderCell>
            <TableCell>{deployment.commit ?? '-'}</TableCell>
            <TableHeaderCell>Created</TableHeaderCell>
            <TableCell>{formatDateTime(deployment.created_at, tz)}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>Deployed</TableHeaderCell>
            <TableCell>
              {deployment.deployed_at ? formatDateTime(deployment.deployed_at, tz) : '-'}
            </TableCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableCell>{project?.type ?? '-'}</TableCell>
          </TableRow>
          <TableRow>
            <TableHeaderCell>CLI Version</TableHeaderCell>
            <TableCell>{deployment.cli_version ?? '-'}</TableCell>
            <TableHeaderCell />
            <TableCell />
          </TableRow>
          {manifest && (
            <TableRow>
              <TableCell colSpan={4} style={{ padding: 0 }}>
                <Collapsible trigger="Manifest">
                  <div style="padding: 0 8px 8px">
                    <Table style={{ margin: 0 }}>
                      <TableBody>
                        {manifest.bindings &&
                          Object.entries(manifest.bindings).map(([type, value]) =>
                            Array.isArray(value) && value.length > 0 ? (
                              <TableRow key={type}>
                                <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                                <TableCell>
                                  {value.map((n: string, i: number) => (
                                    <span key={n}>
                                      {i > 0 && ', '}
                                      <code>{n}</code>
                                    </span>
                                  ))}
                                </TableCell>
                              </TableRow>
                            ) : value === true ? (
                              <TableRow key={type}>
                                <TableHeaderCell>{type.toUpperCase()}</TableHeaderCell>
                                <TableCell>enabled</TableCell>
                              </TableRow>
                            ) : null,
                          )}
                        {manifest.migrations && (
                          <TableRow>
                            <TableHeaderCell>Migrations</TableHeaderCell>
                            <TableCell>
                              {manifest.migrations.dialect} — {manifest.migrations.pending} pending
                            </TableCell>
                          </TableRow>
                        )}
                        {manifest.schedules && manifest.schedules.length > 0 && (
                          <TableRow>
                            <TableHeaderCell>Schedules</TableHeaderCell>
                            <TableCell>
                              {manifest.schedules.map((s, i) => (
                                <span key={s.name}>
                                  {i > 0 && ', '}
                                  {s.name}: {s.cron}
                                </span>
                              ))}
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                    {deployment.manifest && (
                      <Collapsible trigger="Raw JSON">
                        <pre style="margin-top: 8px; font-size: 0.8rem">
                          {JSON.stringify(JSON.parse(deployment.manifest), null, 2)}
                        </pre>
                      </Collapsible>
                    )}
                  </div>
                </Collapsible>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {deployment.status === 'live' && project && <DeploymentLogs deploymentId={deployment.id} />}
    </Layout>
  );
}
