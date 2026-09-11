import Stack, { VStack } from '@nkzw/stack';
import { Link } from '@void/react';
import { Badge, HeadingSection } from '@voidcloud/ui';
import type { Props } from './index.server.ts';

type Project = Extract<Props, { canAccessDashboard: true }>['projects'][number];

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatRelativeTime(value: string | null | undefined, empty = 'No deploy'): string {
  if (!value) {
    return empty;
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return empty;
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
}

function displayDeployStatus(status: string | undefined): string {
  if (
    status === 'pending' ||
    status === 'uploading' ||
    status === 'migrating' ||
    status === 'prerendering'
  ) {
    return 'building';
  }
  return status ?? 'no deploy';
}

function deployStatusClass(status: string | undefined): string {
  if (status === 'live') {
    return 'border-zest/30 bg-zest/10 text-zest';
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

function deployTime(project: Project): string | null {
  const deployment = project.latest_deployment;
  if (!deployment) {
    return null;
  }
  return deployment.status === 'live'
    ? (deployment.deployed_at ?? deployment.created_at)
    : deployment.created_at;
}

function Sparkline({ values }: { values: ReadonlyArray<number> }) {
  const width = 118;
  const height = 30;
  const gap = 2;
  const barWidth = 4;
  const max = Math.max(1, ...values);

  return (
    <svg
      aria-hidden="true"
      className="h-[30px] w-[118px] shrink-0 text-electric"
      fill="currentColor"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      {values.map((value, index) => {
        const barHeight = Math.max(2, Math.round((value / max) * (height - 4)));
        return (
          <rect
            height={barHeight}
            key={index}
            opacity={value === 0 ? 0.22 : 0.8}
            rx="1"
            width={barWidth}
            x={index * (barWidth + gap)}
            y={height - barHeight}
          />
        );
      })}
    </svg>
  );
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

function ChevronRightIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9 18L15 12L9 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ProjectListItem({ project, siteDomain }: { project: Project; siteDomain: string }) {
  const domain = project.custom_domain ?? `${project.slug}.${siteDomain}`;
  const domainHref = `https://${domain}`;
  const deployment = project.latest_deployment;
  const commit = deployment?.commit ? deployment.commit.slice(0, 7) : null;
  const deployMeta = [commit, deployment?.source].filter(Boolean).join(' · ');
  const has5xx = project.health.responses5xx15m > 0;
  const has4xx = project.health.responses4xx15m > 0;

  return (
    <div className="squircle relative border p-4 transition-colors hover:bg-beige/50 dark:hover:bg-nickel/30">
      <Link
        aria-label={`Open ${project.slug}`}
        className="squircle absolute inset-0 z-10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-electric focus-visible:ring-offset-2"
        href={`/projects/${project.id}`}
      />
      <div className="grid gap-4 pr-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,0.95fr)_minmax(20rem,1.15fr)] lg:items-center">
        <VStack className="min-w-0" gap={8}>
          <Stack alignCenter className="min-w-0" gap={12} wrap>
            <code className="squircle bg-beige p-1 dark:bg-slate">{project.slug}</code>
            <Badge
              className="border-stroke bg-white text-grey uppercase dark:border-nickel dark:bg-primary dark:text-white"
              variant="outline"
            >
              {project.type}
            </Badge>
          </Stack>
          <Stack>
            <Stack
              alignCenter
              as="a"
              className="relative z-20 text-sm text-grey underline decoration-1 underline-offset-2 hover:text-primary hover:no-underline dark:hover:text-white"
              gap={4}
              href={domainHref}
              inline
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{domain}</span>
              <ExternalLinkIcon />
            </Stack>
          </Stack>
        </VStack>
        <VStack className="min-w-0 text-sm" gap={8}>
          <Stack alignCenter gap={8} wrap>
            <span
              className={`squircle border px-2 py-1 text-xs uppercase ${deployStatusClass(deployment?.status)}`}
            >
              {displayDeployStatus(deployment?.status)}
            </span>
            <span className="text-grey">{formatRelativeTime(deployTime(project))}</span>
          </Stack>
          <div className="min-w-0 truncate text-xs text-grey">
            {deployMeta || 'No commit/source'}
          </div>
        </VStack>
        <div className="grid min-w-0 gap-3 sm:grid-cols-[118px_minmax(0,1fr)] sm:items-center">
          <Sparkline values={project.traffic.sparkline5m} />
          <div className="grid gap-1 text-sm">
            <Stack alignCenter columnGap={12} rowGap={4} wrap>
              <span className="text-primary dark:text-white">
                {formatNumber(project.traffic.requests5m)} req / 5m
              </span>
            </Stack>
            <Stack alignCenter className="text-xs" columnGap={12} rowGap={4} wrap>
              <span className={has5xx ? 'text-fire' : 'text-grey'}>
                {formatNumber(project.health.responses5xx15m)} 5xx
                {has5xx ? ` · ${formatPercent(project.health.errorRate5xx15m)}` : ''}
              </span>
              <span className={has4xx ? 'text-grey' : 'text-grey/70'}>
                {formatNumber(project.health.responses4xx15m)} 4xx
              </span>
            </Stack>
          </div>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="absolute top-1/2 right-4 -translate-y-1/2 text-primary dark:text-white"
      >
        <ChevronRightIcon />
      </div>
    </div>
  );
}

function PreviewGate() {
  return (
    <main className="bg-white dark:bg-primary">
      <HeadingSection
        heading="Preview access"
        subheading="The Dashboard is not quite ready yet, please use the Void CLI for now."
      />
    </main>
  );
}

export default function DashboardPage(props: Props) {
  if (!props.canAccessDashboard) {
    return <PreviewGate />;
  }

  return (
    <main className="bg-white dark:bg-primary">
      <section className="wrapper wrapper--ticks border-t bg-white px-10 py-8 dark:bg-primary">
        <VStack gap={8}>
          <h2 className="text-3xl text-primary dark:text-white">Void Projects</h2>
        </VStack>
      </section>
      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        {props.projects.length === 0 ? (
          <div className="px-10 py-8 text-grey sm:px-15 sm:py-12">
            No projects yet. Deploy an app with the Void CLI and it will appear here.
          </div>
        ) : (
          <VStack gap={12} padding={20}>
            {props.projects.map((project) => (
              <ProjectListItem key={project.id} project={project} siteDomain={props.siteDomain} />
            ))}
          </VStack>
        )}
      </section>
    </main>
  );
}
