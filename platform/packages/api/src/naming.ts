export function getLegacyProjectWorkerName(slug: string): string {
  return `user-${slug}`;
}

export function getProjectDeploymentWorkerName(slug: string, deploymentId: string): string {
  return `user-${slug}-${deploymentId}`;
}

export function getProjectQueueName(projectId: string, queueName: string): string {
  return `${projectId}-${queueName}`.toLowerCase().replaceAll('_', '-');
}
