/** A concrete destination that can execute a Void deployment. */
export type DeployTarget = 'cloudflare' | 'void';

export type DeployAppType = 'void' | 'spa' | 'static' | 'framework';

export type DeployCapabilitySupport = 'supported' | 'partial' | 'unsupported';

/**
 * Cross-target capabilities used by CLI planning and user-facing diagnostics.
 *
 * A target reports what it can execute today. Capability declarations must not
 * be aspirational: feature gates are removed only when the corresponding
 * adapter and end-to-end coverage exist.
 */
export type DeployTargetCapabilities = {
  managedProjects: boolean;
  skipBuild: boolean;
  appTypes: Readonly<Record<DeployAppType, DeployCapabilitySupport>>;
  features: Readonly<{
    auth: DeployCapabilitySupport;
    cron: DeployCapabilitySupport;
    queues: DeployCapabilitySupport;
    durableState: DeployCapabilitySupport;
    webSockets: DeployCapabilitySupport;
    live: DeployCapabilitySupport;
    sandbox: DeployCapabilitySupport;
    isr: DeployCapabilitySupport;
    remoteDevelopment: DeployCapabilitySupport;
    deploymentHistory: DeployCapabilitySupport;
    rollback: DeployCapabilitySupport;
    secrets: DeployCapabilitySupport;
    domains: DeployCapabilitySupport;
    logs: DeployCapabilitySupport;
  }>;
};

/**
 * Boundary implemented by deployment targets.
 *
 * Build classification and packaging stay outside the adapter; provider
 * credentials, resource names, remote ids, and execution stay inside it.
 */
export type DeployTargetAdapter<TOptions, TContext> = {
  readonly target: DeployTarget;
  readonly capabilities: DeployTargetCapabilities;
  deploy(root: string, options: TOptions, context: TContext): Promise<void>;
};
