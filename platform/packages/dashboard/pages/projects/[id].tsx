import Stack, { VStack } from '@nkzw/stack';
import { Badge } from '@voidcloud/ui';
import type { ReactNode } from 'react';
import type { Props } from './[id].server.ts';

const INPUT_CLASS =
  'w-full min-w-0 border border-stroke bg-white px-3 py-2 text-sm dark:border-nickel dark:bg-primary';

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];
  for (const next of units.slice(1)) {
    if (size < 1024) {
      break;
    }
    size /= 1024;
    unit = next;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function externalHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

function deploymentDisplayStatus({
  active,
  retained,
  status,
}: {
  active: boolean;
  retained: boolean;
  status: string;
}): string {
  if (status === 'live') {
    if (active) {
      return 'live';
    }
    return retained ? 'ready' : 'archived';
  }
  return status;
}

function statusClass(status: string): string {
  if (status === 'live') {
    return 'border-zest/30 bg-zest/10 text-zest';
  }
  if (status === 'ready') {
    return 'border-stroke bg-beige text-grey dark:border-nickel dark:bg-slate dark:text-white/80';
  }
  if (status === 'failed' || status === 'canceled') {
    return 'border-fire/30 bg-fire/10 text-fire';
  }
  if (
    status === 'pending' ||
    status === 'uploading' ||
    status === 'migrating' ||
    status === 'prerendering' ||
    status === 'canceling'
  ) {
    return 'border-electric/30 bg-electric/10 text-electric';
  }
  return 'border-stroke bg-white text-grey dark:border-nickel dark:bg-primary';
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M7 17L17 7M17 7H9M17 7V15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function DomainLink({ domain }: { domain: string }) {
  return (
    <Stack
      alignCenter
      as="a"
      className="w-fit max-w-full text-sm text-grey underline decoration-1 underline-offset-2 hover:text-primary hover:no-underline dark:hover:text-white"
      gap={4}
      href={`https://${domain}`}
      inline
      rel="noopener noreferrer"
      target="_blank"
    >
      <span className="min-w-0 truncate">{domain}</span>
      <ExternalLinkIcon />
    </Stack>
  );
}

function CommitLink({ commit, href }: { commit: string | null; href?: string | null }) {
  if (!commit) {
    return '-';
  }

  const shortCommit = commit.slice(0, 7);
  const commitUrl = externalHttpUrl(href);
  if (!commitUrl) {
    return shortCommit;
  }

  return (
    <Stack
      alignCenter
      as="a"
      className="w-fit max-w-full text-primary underline decoration-1 underline-offset-2 hover:text-grey hover:no-underline dark:text-white dark:hover:text-grey"
      gap={4}
      href={commitUrl}
      inline
      rel="noopener noreferrer"
      target="_blank"
    >
      <span>{shortCommit}</span>
      <ExternalLinkIcon />
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <VStack className="min-w-0" gap={8}>
        <span className="text-xs text-grey uppercase">{label}</span>
        <span className="min-w-0 truncate text-lg text-primary dark:text-white">{value}</span>
      </VStack>
    </div>
  );
}

function SectionHeader({
  compact,
  meta,
  title,
}: {
  compact?: boolean;
  meta?: string;
  title: string;
}) {
  return (
    <Stack
      alignCenter
      between
      className={`border-b border-stroke px-5 py-4 dark:border-nickel ${compact ? '' : 'sm:px-10'}`}
      gap={16}
    >
      <h3 className="text-primary dark:text-white">{title}</h3>
      {meta ? <span className="text-xs text-grey uppercase">{meta}</span> : null}
    </Stack>
  );
}

function DeploymentStatus({
  active,
  retained,
  status,
}: {
  active: boolean;
  retained: boolean;
  status: string;
}) {
  const displayStatus = deploymentDisplayStatus({ active, retained, status });

  return (
    <span className={`squircle border px-2 py-1 text-xs uppercase ${statusClass(displayStatus)}`}>
      {displayStatus}
    </span>
  );
}

function DomainRow({
  hostname,
  isPrimary,
  status,
  children,
}: {
  children?: ReactNode;
  hostname: string;
  isPrimary?: boolean;
  status: string;
}) {
  return (
    <div className="squircle border p-4 dark:border-nickel">
      <Stack alignCenter between gap={16} wrap>
        <VStack className="min-w-0" gap={8}>
          <DomainLink domain={hostname} />
          <Stack alignCenter className="text-xs text-grey" gap={8} wrap>
            <span>{status}</span>
            {isPrimary ? (
              <>
                &middot;<span>primary display domain</span>
              </>
            ) : null}
          </Stack>
        </VStack>
        {children}
      </Stack>
    </div>
  );
}

export default function ProjectPage({
  project,
  deployments,
  domains,
  resources,
  usage,
  secrets,
  siteDomain,
}: Props) {
  const defaultDomain = `${project.slug}.${siteDomain}`;
  const assignedDomain = domains.find((domain) => domain.status === 'active') ?? domains[0];
  const displayDomain = assignedDomain?.hostname ?? defaultDomain;

  return (
    <main className="bg-white dark:bg-primary">
      <section className="wrapper wrapper--ticks border-t bg-white px-10 py-8 dark:bg-primary">
        <VStack gap={8}>
          <Stack alignCenter gap={12} wrap>
            <h2 className="text-3xl text-primary dark:text-white">{project.slug}</h2>
            <Badge
              className="border-stroke bg-white text-grey uppercase dark:border-nickel dark:bg-primary dark:text-white"
              variant="outline"
            >
              {project.type}
            </Badge>
          </Stack>
          <DomainLink domain={displayDomain} />
        </VStack>
      </section>
      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        <div className="grid divide-y divide-stroke border-b border-stroke dark:divide-nickel dark:border-nickel sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          <Metric label="Requests" value={formatNumber(usage.requests)} />
          <Metric label="Bandwidth" value={formatBytes(usage.bandwidthBytes)} />
          <Metric label="AI neurons" value={formatNumber(usage.aiNeurons)} />
          <Metric label="Project type" value={project.type} />
        </div>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] lg:divide-x lg:divide-stroke lg:dark:divide-nickel">
          <div className="divide-y divide-stroke dark:divide-nickel">
            <section>
              <SectionHeader
                meta={`${formatNumber(deployments.deployments.length)} total`}
                title="Deployments"
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                  <thead>
                    <tr>
                      <th className="px-5 py-2.5 text-xs font-normal text-grey uppercase first:pl-10 last:pr-10">
                        Status
                      </th>
                      <th className="px-5 py-2.5 text-xs font-normal text-grey uppercase first:pl-10 last:pr-10">
                        Source
                      </th>
                      <th className="px-5 py-2.5 text-xs font-normal text-grey uppercase first:pl-10 last:pr-10">
                        Commit
                      </th>
                      <th className="px-5 py-2.5 text-xs font-normal text-grey uppercase first:pl-10 last:pr-10">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deployments.deployments.map((deployment) => (
                      <tr key={deployment.id}>
                        <td className="border-t border-stroke px-5 py-3.5 first:pl-10 last:pr-10 dark:border-nickel">
                          <DeploymentStatus
                            active={deployment.id === deployments.activeDeploymentId}
                            retained={deployment.retained}
                            status={deployment.status}
                          />
                        </td>
                        <td className="border-t border-stroke px-5 py-3.5 text-grey first:pl-10 last:pr-10 dark:border-nickel">
                          <span className="block max-w-44 truncate">
                            {deployment.source ?? '-'}
                          </span>
                        </td>
                        <td className="border-t border-stroke px-5 py-3.5 font-mono text-xs text-primary first:pl-10 last:pr-10 dark:border-nickel dark:text-white">
                          <CommitLink commit={deployment.commit} href={deployment.commit_url} />
                        </td>
                        <td className="border-t border-stroke px-5 py-3.5 text-grey first:pl-10 last:pr-10 dark:border-nickel">
                          {formatDate(deployment.created_at)}
                        </td>
                      </tr>
                    ))}
                    {deployments.deployments.length === 0 && (
                      <tr>
                        <td
                          className="border-t border-stroke px-10 py-6 text-sm text-grey dark:border-nickel"
                          colSpan={4}
                        >
                          No deployments yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <SectionHeader meta={`${formatNumber(domains.length + 1)} total`} title="Domains" />
              <VStack className="px-5 py-5 sm:px-10 sm:py-8" gap={12}>
                <DomainRow
                  hostname={defaultDomain}
                  isPrimary={!assignedDomain}
                  status="active default domain"
                />
                {domains.map((domain) => (
                  <DomainRow
                    hostname={domain.hostname}
                    isPrimary={domain.hostname === displayDomain}
                    key={domain.id}
                    status={domain.status}
                  >
                    <form method="post">
                      <input type="hidden" name="_intent" value="remove-domain" />
                      <input type="hidden" name="domainId" value={domain.id} />
                      <button className="button button--sm" type="submit">
                        Remove
                      </button>
                    </form>
                  </DomainRow>
                ))}
                <div className="squircle border p-4 dark:border-nickel">
                  <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" method="post">
                    <input type="hidden" name="_intent" value="add-domain" />
                    <input className={INPUT_CLASS} name="hostname" placeholder="www.example.com" />
                    <button className="button" type="submit">
                      Add domain
                    </button>
                  </form>
                </div>
              </VStack>
            </section>
          </div>

          <aside className="divide-y divide-stroke dark:divide-nickel">
            <section>
              <SectionHeader
                compact
                meta={`${formatNumber(resources.length)} total`}
                title="Resources"
              />
              <div className="divide-y divide-stroke dark:divide-nickel">
                {resources.map((resource) => (
                  <div key={resource.id} className="px-5 py-3">
                    <VStack className="min-w-0" gap={4}>
                      <span className="min-w-0 truncate font-mono text-xs text-primary dark:text-white">
                        {resource.binding_name}
                      </span>
                      <span className="text-xs text-grey">{resource.type}</span>
                    </VStack>
                  </div>
                ))}
                {resources.length === 0 && (
                  <div className="px-5 py-4 text-sm text-grey">No provisioned resources.</div>
                )}
              </div>
            </section>

            <section>
              <SectionHeader
                compact
                meta={`${formatNumber(secrets.length)} total`}
                title="Secrets"
              />
              <VStack className="p-5" gap={12}>
                <div className="divide-y divide-stroke border border-stroke dark:divide-nickel dark:border-nickel">
                  {secrets.map((secret) => (
                    <Stack alignCenter between gap={12} key={secret.name} padding={12}>
                      <span className="min-w-0 truncate font-mono text-xs text-primary dark:text-white">
                        {secret.name}
                      </span>
                      <form method="post">
                        <input type="hidden" name="_intent" value="remove-secret" />
                        <input type="hidden" name="name" value={secret.name} />
                        <button className="button button--sm" type="submit">
                          Remove
                        </button>
                      </form>
                    </Stack>
                  ))}
                  {secrets.length === 0 && (
                    <div className="p-3 text-sm text-grey">No project secrets.</div>
                  )}
                </div>
                <VStack as="form" gap={8} method="post">
                  <input type="hidden" name="_intent" value="add-secret" />
                  <input className={INPUT_CLASS} name="name" placeholder="API_KEY" />
                  <input
                    className={INPUT_CLASS}
                    name="value"
                    placeholder="Secret value"
                    type="password"
                  />
                  <button className="button w-full" type="submit">
                    Save secret
                  </button>
                </VStack>
              </VStack>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
